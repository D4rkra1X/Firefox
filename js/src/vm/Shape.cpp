/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: set ts=8 sts=2 et sw=2 tw=80:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "vm/Shape-inl.h"

#include "mozilla/MathAlgorithms.h"
#include "mozilla/PodOperations.h"

#include "gc/HashUtil.h"
#include "js/friend/WindowProxy.h"  // js::IsWindow
#include "js/HashTable.h"
#include "js/UniquePtr.h"
#include "vm/JSContext.h"
#include "vm/JSObject.h"
#include "vm/ShapeZone.h"
#include "vm/Watchtower.h"

#include "gc/Zone-inl.h"
#include "vm/JSObject-inl.h"
#include "vm/NativeObject-inl.h"

using namespace js;

using mozilla::CeilingLog2Size;
using mozilla::PodZero;

using JS::AutoCheckCannotGC;

/* static */
bool Shape::replaceShape(JSContext* cx, HandleObject obj,
                         ObjectFlags objectFlags, TaggedProto proto,
                         uint32_t nfixed) {
  MOZ_ASSERT(!obj->shape()->isDictionary());

  Shape* newShape;
  if (obj->shape()->propMap()) {
    Rooted<BaseShape*> base(cx, obj->shape()->base());
    if (proto != base->proto()) {
      Rooted<TaggedProto> protoRoot(cx, proto);
      base = BaseShape::get(cx, base->clasp(), base->realm(), protoRoot);
      if (!base) {
        return false;
      }
    }
    Rooted<SharedPropMap*> map(cx, obj->shape()->sharedPropMap());
    uint32_t mapLength = obj->shape()->propMapLength();
    newShape = SharedShape::getPropMapShape(cx, base, nfixed, map, mapLength,
                                            objectFlags);
  } else {
    newShape = SharedShape::getInitialShape(cx, obj->shape()->getObjectClass(),
                                            obj->shape()->realm(), proto,
                                            nfixed, objectFlags);
  }
  if (!newShape) {
    return false;
  }

  obj->setShape(newShape);
  return true;
}

/* static */
bool js::NativeObject::toDictionaryMode(JSContext* cx,
                                        Handle<NativeObject*> obj) {
  MOZ_ASSERT(!obj->inDictionaryMode());
  MOZ_ASSERT(cx->isInsideCurrentCompartment(obj));

  Rooted<Shape*> shape(cx, obj->shape());
  uint32_t span = obj->slotSpan();

  uint32_t mapLength = shape->propMapLength();
  MOZ_ASSERT(mapLength > 0, "shouldn't convert empty object to dictionary");

  // Clone the shared property map to an unshared dictionary map.
  Rooted<SharedPropMap*> map(cx, shape->propMap()->asShared());
  Rooted<DictionaryPropMap*> dictMap(
      cx, SharedPropMap::toDictionaryMap(cx, map, mapLength));
  if (!dictMap) {
    return false;
  }

  // Allocate and use a new dictionary shape.
  Rooted<BaseShape*> base(cx, shape->base());
  shape = DictionaryShape::new_(cx, base, shape->objectFlags(),
                                shape->numFixedSlots(), dictMap, mapLength);
  if (!shape) {
    return false;
  }
  obj->setShape(shape);

  MOZ_ASSERT(obj->inDictionaryMode());
  obj->setDictionaryModeSlotSpan(span);

  return true;
}

namespace js {

class MOZ_RAII AutoCheckShapeConsistency {
#ifdef DEBUG
  Handle<NativeObject*> obj_;
#endif

 public:
  explicit AutoCheckShapeConsistency(Handle<NativeObject*> obj)
#ifdef DEBUG
      : obj_(obj)
#endif
  {
  }

#ifdef DEBUG
  ~AutoCheckShapeConsistency() { obj_->checkShapeConsistency(); }
#endif
};

}  // namespace js

/* static */ MOZ_ALWAYS_INLINE bool
NativeObject::maybeConvertToDictionaryForAdd(JSContext* cx,
                                             Handle<NativeObject*> obj) {
  if (obj->inDictionaryMode()) {
    return true;
  }
  SharedPropMap* map = obj->shape()->sharedPropMap();
  if (!map) {
    return true;
  }
  if (MOZ_LIKELY(!map->shouldConvertToDictionaryForAdd())) {
    return true;
  }
  return toDictionaryMode(cx, obj);
}

static void AssertValidCustomDataProp(NativeObject* obj, PropertyFlags flags) {
  // We only support custom data properties on ArrayObject and ArgumentsObject.
  // The mechanism is deprecated so we don't want to add new uses.
  MOZ_ASSERT(flags.isCustomDataProperty());
  MOZ_ASSERT(!flags.isAccessorProperty());
  MOZ_ASSERT(obj->is<ArrayObject>() || obj->is<ArgumentsObject>());
}

/* static */
bool NativeObject::addCustomDataProperty(JSContext* cx,
                                         Handle<NativeObject*> obj, HandleId id,
                                         PropertyFlags flags) {
  MOZ_ASSERT(!id.isVoid());
  MOZ_ASSERT(!id.isPrivateName());
  MOZ_ASSERT(!obj->containsPure(id));

  AutoCheckShapeConsistency check(obj);
  AssertValidCustomDataProp(obj, flags);

  if (!Watchtower::watchPropertyAdd(cx, obj, id)) {
    return false;
  }

  if (!maybeConvertToDictionaryForAdd(cx, obj)) {
    return false;
  }

  ObjectFlags objectFlags = obj->shape()->objectFlags();
  const JSClass* clasp = obj->shape()->getObjectClass();

  if (obj->inDictionaryMode()) {
    // First generate a new dictionary shape so that the map can be mutated
    // without having to worry about OOM conditions.
    if (!NativeObject::generateNewDictionaryShape(cx, obj)) {
      return false;
    }

    Rooted<DictionaryPropMap*> map(cx, obj->shape()->dictionaryPropMap());
    uint32_t mapLength = obj->shape()->propMapLength();
    if (!DictionaryPropMap::addProperty(cx, clasp, &map, &mapLength, id, flags,
                                        SHAPE_INVALID_SLOT, &objectFlags)) {
      return false;
    }

    obj->shape()->updateNewDictionaryShape(objectFlags, map, mapLength);
    return true;
  }

  Rooted<SharedPropMap*> map(cx, obj->shape()->sharedPropMap());
  uint32_t mapLength = obj->shape()->propMapLength();
  if (!SharedPropMap::addCustomDataProperty(cx, clasp, &map, &mapLength, id,
                                            flags, &objectFlags)) {
    return false;
  }

  Shape* shape = SharedShape::getPropMapShape(cx, obj->shape()->base(),
                                              obj->shape()->numFixedSlots(),
                                              map, mapLength, objectFlags);
  if (!shape) {
    return false;
  }

  obj->setShape(shape);
  return true;
}

static ShapeSetForAdd* MakeShapeSetForAdd(Shape* shape1, Shape* shape2) {
  MOZ_ASSERT(shape1 != shape2);
  MOZ_ASSERT(shape1->propMapLength() == shape2->propMapLength());

  auto hash = MakeUnique<ShapeSetForAdd>();
  if (!hash || !hash->reserve(2)) {
    return nullptr;
  }

  PropertyInfoWithKey prop = shape1->lastProperty();
  hash->putNewInfallible(ShapeForAddHasher::Lookup(prop.key(), prop.flags()),
                         shape1);

  prop = shape2->lastProperty();
  hash->putNewInfallible(ShapeForAddHasher::Lookup(prop.key(), prop.flags()),
                         shape2);

  return hash.release();
}

static MOZ_ALWAYS_INLINE Shape* LookupShapeForAdd(Shape* shape, PropertyKey key,
                                                  PropertyFlags flags,
                                                  uint32_t* slot) {
  ShapeCachePtr cache = shape->cache();

  if (cache.isSingleShapeForAdd()) {
    Shape* newShape = cache.toSingleShapeForAdd();
    if (newShape->lastPropertyMatchesForAdd(key, flags, slot)) {
      return newShape;
    }
    return nullptr;
  }

  if (cache.isShapeSetForAdd()) {
    ShapeSetForAdd* set = cache.toShapeSetForAdd();
    ShapeForAddHasher::Lookup lookup(key, flags);
    if (auto p = set->lookup(lookup)) {
      Shape* newShape = *p;
      *slot = newShape->lastProperty().slot();
      return newShape;
    }
    return nullptr;
  }

  MOZ_ASSERT(!cache.isForAdd());
  return nullptr;
}

// Add shapes with a non-None ShapeCachePtr to the shapesWithCache list so that
// these caches can be discarded on GC.
static bool RegisterShapeCache(JSContext* cx, Shape* shape) {
  ShapeCachePtr cache = shape->cache();
  if (!cache.isNone()) {
    // Already registered this shape.
    return true;
  }
  return cx->zone()->shapeZone().shapesWithCache.append(shape);
}

/* static */
bool NativeObject::addProperty(JSContext* cx, Handle<NativeObject*> obj,
                               HandleId id, PropertyFlags flags,
                               uint32_t* slot) {
  AutoCheckShapeConsistency check(obj);
  MOZ_ASSERT(!flags.isCustomDataProperty(),
             "Use addCustomDataProperty for custom data properties");

  // The object must not contain a property named |id|. The object must be
  // extensible, but allow private fields and sparsifying dense elements.
  MOZ_ASSERT(!id.isVoid());
  MOZ_ASSERT(!obj->containsPure(id));
  MOZ_ASSERT_IF(!id.isPrivateName(),
                obj->isExtensible() ||
                    (id.isInt() && obj->containsDenseElement(id.toInt())) ||
                    // R&T wrappers are non-extensible, but we still want to be
                    // able to lazily resolve their properties. We can
                    // special-case them to allow doing so.
                    IF_RECORD_TUPLE(IsExtendedPrimitiveWrapper(*obj), false));

  if (!Watchtower::watchPropertyAdd(cx, obj, id)) {
    return false;
  }

  if (!maybeConvertToDictionaryForAdd(cx, obj)) {
    return false;
  }

  if (Shape* shape = LookupShapeForAdd(obj->shape(), id, flags, slot)) {
    return obj->setShapeAndAddNewSlot(cx, shape, *slot);
  }

  if (obj->inDictionaryMode()) {
    // First generate a new dictionary shape so that the map and shape can be
    // mutated without having to worry about OOM conditions.
    if (!NativeObject::generateNewDictionaryShape(cx, obj)) {
      return false;
    }
    if (!allocDictionarySlot(cx, obj, slot)) {
      return false;
    }

    ObjectFlags objectFlags = obj->shape()->objectFlags();
    const JSClass* clasp = obj->shape()->getObjectClass();

    Rooted<DictionaryPropMap*> map(cx, obj->shape()->propMap()->asDictionary());
    uint32_t mapLength = obj->shape()->propMapLength();
    if (!DictionaryPropMap::addProperty(cx, clasp, &map, &mapLength, id, flags,
                                        *slot, &objectFlags)) {
      return false;
    }

    obj->shape()->updateNewDictionaryShape(objectFlags, map, mapLength);
    return true;
  }

  ObjectFlags objectFlags = obj->shape()->objectFlags();
  const JSClass* clasp = obj->shape()->getObjectClass();

  Rooted<SharedPropMap*> map(cx, obj->shape()->sharedPropMap());
  uint32_t mapLength = obj->shape()->propMapLength();

  if (!SharedPropMap::addProperty(cx, clasp, &map, &mapLength, id, flags,
                                  &objectFlags, slot)) {
    return false;
  }

  bool allocatedNewShape;
  Shape* newShape = SharedShape::getPropMapShape(
      cx, obj->shape()->base(), obj->shape()->numFixedSlots(), map, mapLength,
      objectFlags, &allocatedNewShape);
  if (!newShape) {
    return false;
  }

  Shape* oldShape = obj->shape();
  if (!obj->setShapeAndAddNewSlot(cx, newShape, *slot)) {
    return false;
  }

  // Add the new shape to the old shape's shape cache, to optimize this shape
  // transition. Don't do this if we just allocated a new shape, because that
  // suggests this may not be a hot transition that would benefit from the
  // cache.

  if (allocatedNewShape) {
    return true;
  }

  if (!RegisterShapeCache(cx, oldShape)) {
    // Ignore OOM, the cache is just an optimization.
    return true;
  }

  ShapeCachePtr& cache = oldShape->cacheRef();
  if (!cache.isForAdd()) {
    cache.setSingleShapeForAdd(newShape);
  } else if (cache.isSingleShapeForAdd()) {
    Shape* prevShape = cache.toSingleShapeForAdd();
    if (ShapeSetForAdd* set = MakeShapeSetForAdd(prevShape, newShape)) {
      cache.setShapeSetForAdd(set);
      AddCellMemory(oldShape, sizeof(ShapeSetForAdd),
                    MemoryUse::ShapeSetForAdd);
    }
  } else {
    ShapeForAddHasher::Lookup lookup(id, flags);
    (void)cache.toShapeSetForAdd()->putNew(lookup, newShape);
  }

  return true;
}

void Shape::maybeCacheIterator(JSContext* cx, PropertyIteratorObject* iter) {
  if (!cache().isNone() && !cache().isIterator()) {
    // If we're already caching other shape data, skip caching the iterator.
    return;
  }
  if (MOZ_UNLIKELY(!RegisterShapeCache(cx, this))) {
    // Ignore OOM. The cache is just an optimization.
    return;
  }
  cacheRef().setIterator(iter);
}

/* static */
bool NativeObject::addPropertyInReservedSlot(JSContext* cx,
                                             Handle<NativeObject*> obj,
                                             HandleId id, uint32_t slot,
                                             PropertyFlags flags) {
  AutoCheckShapeConsistency check(obj);
  MOZ_ASSERT(!flags.isCustomDataProperty(),
             "Use addCustomDataProperty for custom data properties");

  // The slot must be a reserved slot.
  MOZ_ASSERT(slot < JSCLASS_RESERVED_SLOTS(obj->getClass()));

  // The object must not contain a property named |id| and must be extensible.
  MOZ_ASSERT(!id.isVoid());
  MOZ_ASSERT(!obj->containsPure(id));
  MOZ_ASSERT(!id.isPrivateName());
  MOZ_ASSERT(obj->isExtensible());

  // The object must not be in dictionary mode. This simplifies the code below.
  MOZ_ASSERT(!obj->inDictionaryMode());

  // We don't need to call Watchtower::watchPropertyAdd here because this isn't
  // used for any watched objects.
  MOZ_ASSERT(!Watchtower::watchesPropertyAdd(obj));

  ObjectFlags objectFlags = obj->shape()->objectFlags();
  const JSClass* clasp = obj->shape()->getObjectClass();

  Rooted<SharedPropMap*> map(cx, obj->shape()->sharedPropMap());
  uint32_t mapLength = obj->shape()->propMapLength();
  if (!SharedPropMap::addPropertyInReservedSlot(cx, clasp, &map, &mapLength, id,
                                                flags, slot, &objectFlags)) {
    return false;
  }

  Shape* shape = SharedShape::getPropMapShape(cx, obj->shape()->base(),
                                              obj->shape()->numFixedSlots(),
                                              map, mapLength, objectFlags);
  if (!shape) {
    return false;
  }
  obj->setShape(shape);

  MOZ_ASSERT(obj->getLastProperty().slot() == slot);
  return true;
}

/*
 * Assert some invariants that should hold when changing properties. It's the
 * responsibility of the callers to ensure these hold.
 */
static void AssertCanChangeFlags(PropertyInfo prop, PropertyFlags flags) {
#ifdef DEBUG
  if (prop.configurable()) {
    return;
  }

  // A non-configurable property must stay non-configurable.
  MOZ_ASSERT(!flags.configurable());

  // Reject attempts to turn a non-configurable data property into an accessor
  // or custom data property.
  MOZ_ASSERT_IF(prop.isDataProperty(), flags.isDataProperty());

  // Reject attempts to turn a non-configurable accessor property into a data
  // property or custom data property.
  MOZ_ASSERT_IF(prop.isAccessorProperty(), flags.isAccessorProperty());
#endif
}

static void AssertValidArrayIndex(NativeObject* obj, jsid id) {
#ifdef DEBUG
  if (obj->is<ArrayObject>()) {
    ArrayObject* arr = &obj->as<ArrayObject>();
    uint32_t index;
    if (IdIsIndex(id, &index)) {
      MOZ_ASSERT(index < arr->length() || arr->lengthIsWritable());
    }
  }
#endif
}

/* static */
bool NativeObject::changeProperty(JSContext* cx, Handle<NativeObject*> obj,
                                  HandleId id, PropertyFlags flags,
                                  uint32_t* slotOut) {
  MOZ_ASSERT(!id.isVoid());

  AutoCheckShapeConsistency check(obj);
  AssertValidArrayIndex(obj, id);
  MOZ_ASSERT(!flags.isCustomDataProperty(),
             "Use changeCustomDataPropAttributes for custom data properties");

  if (!Watchtower::watchPropertyChange(cx, obj, id)) {
    return false;
  }

  Rooted<PropMap*> map(cx, obj->shape()->propMap());
  uint32_t mapLength = obj->shape()->propMapLength();

  uint32_t propIndex;
  Rooted<PropMap*> propMap(cx, map->lookup(cx, mapLength, id, &propIndex));
  MOZ_ASSERT(propMap);

  ObjectFlags objectFlags = obj->shape()->objectFlags();

  PropertyInfo oldProp = propMap->getPropertyInfo(propIndex);
  AssertCanChangeFlags(oldProp, flags);

  if (oldProp.isAccessorProperty()) {
    objectFlags.setFlag(ObjectFlag::HadGetterSetterChange);
  }

  // If the property flags are not changing, the only thing we have to do is
  // update the object flags. This prevents a dictionary mode conversion below.
  if (oldProp.flags() == flags) {
    if (objectFlags == obj->shape()->objectFlags()) {
      *slotOut = oldProp.slot();
      return true;
    }
    if (map->isShared()) {
      if (!Shape::replaceShape(cx, obj, objectFlags, obj->shape()->proto(),
                               obj->shape()->numFixedSlots())) {
        return false;
      }
      *slotOut = oldProp.slot();
      return true;
    }
  }

  const JSClass* clasp = obj->shape()->getObjectClass();

  if (map->isShared()) {
    // Fast path for changing the last property in a SharedPropMap. Call
    // getPrevious to "remove" the last property and then call addProperty
    // to re-add the last property with the new flags.
    if (propMap == map && propIndex == mapLength - 1) {
      MOZ_ASSERT(obj->getLastProperty().key() == id);

      Rooted<SharedPropMap*> sharedMap(cx, map->asShared());
      SharedPropMap::getPrevious(&sharedMap, &mapLength);

      if (MOZ_LIKELY(oldProp.hasSlot())) {
        *slotOut = oldProp.slot();
        if (!SharedPropMap::addPropertyWithKnownSlot(cx, clasp, &sharedMap,
                                                     &mapLength, id, flags,
                                                     *slotOut, &objectFlags)) {
          return false;
        }
      } else {
        if (!SharedPropMap::addProperty(cx, clasp, &sharedMap, &mapLength, id,
                                        flags, &objectFlags, slotOut)) {
          return false;
        }
      }

      Shape* newShape = SharedShape::getPropMapShape(
          cx, obj->shape()->base(), obj->shape()->numFixedSlots(), sharedMap,
          mapLength, objectFlags);
      if (!newShape) {
        return false;
      }

      if (MOZ_LIKELY(oldProp.hasSlot())) {
        MOZ_ASSERT(obj->shape()->slotSpan() == newShape->slotSpan());
        obj->setShape(newShape);
        return true;
      }
      return obj->setShapeAndAddNewSlot(cx, newShape, *slotOut);
    }

    // Changing a non-last property. Switch to dictionary mode and relookup
    // pointers for the new dictionary map.
    if (!NativeObject::toDictionaryMode(cx, obj)) {
      return false;
    }
    map = obj->shape()->propMap();
    propMap = map->lookup(cx, mapLength, id, &propIndex);
    MOZ_ASSERT(propMap);
  } else {
    if (!NativeObject::generateNewDictionaryShape(cx, obj)) {
      return false;
    }
  }

  // The object has a new dictionary shape (see toDictionaryMode and
  // generateNewDictionaryShape calls above), so we can mutate the map and shape
  // in place.

  MOZ_ASSERT(map->isDictionary());
  MOZ_ASSERT(propMap->isDictionary());

  uint32_t slot = oldProp.hasSlot() ? oldProp.slot() : SHAPE_INVALID_SLOT;
  if (slot == SHAPE_INVALID_SLOT) {
    if (!allocDictionarySlot(cx, obj, &slot)) {
      return false;
    }
  }

  propMap->asDictionary()->changeProperty(cx, clasp, propIndex, flags, slot,
                                          &objectFlags);
  obj->shape()->setObjectFlags(objectFlags);

  *slotOut = slot;
  return true;
}

/* static */
bool NativeObject::changeCustomDataPropAttributes(JSContext* cx,
                                                  Handle<NativeObject*> obj,
                                                  HandleId id,
                                                  PropertyFlags flags) {
  MOZ_ASSERT(!id.isVoid());

  AutoCheckShapeConsistency check(obj);
  AssertValidArrayIndex(obj, id);
  AssertValidCustomDataProp(obj, flags);

  if (!Watchtower::watchPropertyChange(cx, obj, id)) {
    return false;
  }

  Rooted<PropMap*> map(cx, obj->shape()->propMap());
  uint32_t mapLength = obj->shape()->propMapLength();

  uint32_t propIndex;
  Rooted<PropMap*> propMap(cx, map->lookup(cx, mapLength, id, &propIndex));
  MOZ_ASSERT(propMap);

  PropertyInfo oldProp = propMap->getPropertyInfo(propIndex);
  MOZ_ASSERT(oldProp.isCustomDataProperty());
  AssertCanChangeFlags(oldProp, flags);

  // If the property flags are not changing, we're done.
  if (oldProp.flags() == flags) {
    return true;
  }

  const JSClass* clasp = obj->shape()->getObjectClass();
  ObjectFlags objectFlags = obj->shape()->objectFlags();

  if (map->isShared()) {
    // Fast path for changing the last property in a SharedPropMap. Call
    // getPrevious to "remove" the last property and then call
    // addCustomDataProperty to re-add the last property with the new flags.
    if (propMap == map && propIndex == mapLength - 1) {
      MOZ_ASSERT(obj->getLastProperty().key() == id);

      Rooted<SharedPropMap*> sharedMap(cx, map->asShared());
      SharedPropMap::getPrevious(&sharedMap, &mapLength);

      if (!SharedPropMap::addCustomDataProperty(
              cx, clasp, &sharedMap, &mapLength, id, flags, &objectFlags)) {
        return false;
      }

      Shape* newShape = SharedShape::getPropMapShape(
          cx, obj->shape()->base(), obj->shape()->numFixedSlots(), sharedMap,
          mapLength, objectFlags);
      if (!newShape) {
        return false;
      }
      obj->setShape(newShape);
      return true;
    }

    // Changing a non-last property. Switch to dictionary mode and relookup
    // pointers for the new dictionary map.
    if (!NativeObject::toDictionaryMode(cx, obj)) {
      return false;
    }
    map = obj->shape()->propMap();
    propMap = map->lookup(cx, mapLength, id, &propIndex);
    MOZ_ASSERT(propMap);
  } else {
    if (!NativeObject::generateNewDictionaryShape(cx, obj)) {
      return false;
    }
  }

  // The object has a new dictionary shape (see toDictionaryMode and
  // generateNewDictionaryShape calls above), so we can mutate the map and shape
  // in place.

  MOZ_ASSERT(map->isDictionary());
  MOZ_ASSERT(propMap->isDictionary());

  propMap->asDictionary()->changePropertyFlags(cx, clasp, propIndex, flags,
                                               &objectFlags);
  obj->shape()->setObjectFlags(objectFlags);
  return true;
}

void NativeObject::maybeFreeDictionaryPropSlots(JSContext* cx,
                                                DictionaryPropMap* map,
                                                uint32_t mapLength) {
  // We can free all non-reserved slots if there are no properties left. We also
  // handle the case where there's a single slotless property, to support arrays
  // (array.length is a custom data property).

  MOZ_ASSERT(shape()->dictionaryPropMap() == map);
  MOZ_ASSERT(shape()->propMapLength() == mapLength);

  if (mapLength > 1 || map->previous()) {
    return;
  }
  if (mapLength == 1 && map->getPropertyInfo(0).hasSlot()) {
    return;
  }

  uint32_t oldSpan = dictionaryModeSlotSpan();
  uint32_t newSpan = JSCLASS_RESERVED_SLOTS(getClass());
  if (oldSpan == newSpan) {
    return;
  }

  MOZ_ASSERT(newSpan < oldSpan);

  // Trigger write barriers on the old slots before reallocating.
  prepareSlotRangeForOverwrite(newSpan, oldSpan);
  invalidateSlotRange(newSpan, oldSpan);

  uint32_t oldCapacity = numDynamicSlots();
  uint32_t newCapacity =
      calculateDynamicSlots(numFixedSlots(), newSpan, getClass());
  if (newCapacity < oldCapacity) {
    shrinkSlots(cx, oldCapacity, newCapacity);
  }

  setDictionaryModeSlotSpan(newSpan);
  map->setFreeList(SHAPE_INVALID_SLOT);
}

void NativeObject::setShapeAndRemoveLastSlot(JSContext* cx, Shape* newShape,
                                             uint32_t slot) {
  MOZ_ASSERT(!inDictionaryMode());
  MOZ_ASSERT(!newShape->isDictionary());
  MOZ_ASSERT(newShape->slotSpan() == slot);

  uint32_t numFixed = newShape->numFixedSlots();
  if (slot < numFixed) {
    setFixedSlot(slot, UndefinedValue());
  } else {
    setDynamicSlot(numFixed, slot, UndefinedValue());
    uint32_t oldCapacity = numDynamicSlots();
    uint32_t newCapacity = calculateDynamicSlots(numFixed, slot, getClass());
    MOZ_ASSERT(newCapacity <= oldCapacity);
    if (newCapacity < oldCapacity) {
      shrinkSlots(cx, oldCapacity, newCapacity);
    }
  }

  setShape(newShape);
}

/* static */
bool NativeObject::removeProperty(JSContext* cx, Handle<NativeObject*> obj,
                                  HandleId id) {
  AutoCheckShapeConsistency check(obj);

  Rooted<PropMap*> map(cx, obj->shape()->propMap());
  uint32_t mapLength = obj->shape()->propMapLength();

  AutoKeepPropMapTables keep(cx);
  PropMapTable* table;
  PropMapTable::Ptr ptr;
  Rooted<PropMap*> propMap(cx);
  uint32_t propIndex;
  if (!PropMap::lookupForRemove(cx, map, mapLength, id, keep, propMap.address(),
                                &propIndex, &table, &ptr)) {
    return false;
  }

  if (!propMap) {
    return true;
  }

  if (!Watchtower::watchPropertyRemove(cx, obj, id)) {
    return false;
  }

  PropertyInfo prop = propMap->getPropertyInfo(propIndex);

  // If we're removing an accessor property, ensure the HadGetterSetterChange
  // object flag is set. This is necessary because the slot holding the
  // GetterSetter can be changed indirectly by removing the property and then
  // adding it back with a different GetterSetter value but the same shape.
  if (prop.isAccessorProperty() && !obj->hadGetterSetterChange()) {
    if (!NativeObject::setHadGetterSetterChange(cx, obj)) {
      return false;
    }
  }

  if (map->isShared()) {
    // Fast path for removing the last property from a SharedPropMap. In this
    // case we can just call getPrevious and then look up a shape for the
    // resulting map/mapLength.
    if (propMap == map && propIndex == mapLength - 1) {
      MOZ_ASSERT(obj->getLastProperty().key() == id);

      Rooted<SharedPropMap*> sharedMap(cx, map->asShared());
      SharedPropMap::getPrevious(&sharedMap, &mapLength);

      Shape* shape = obj->shape();
      Shape* newShape;
      if (sharedMap) {
        newShape = SharedShape::getPropMapShape(
            cx, shape->base(), shape->numFixedSlots(), sharedMap, mapLength,
            shape->objectFlags());
      } else {
        newShape = SharedShape::getInitialShape(
            cx, shape->getObjectClass(), shape->realm(), shape->proto(),
            shape->numFixedSlots(), shape->objectFlags());
      }
      if (!newShape) {
        return false;
      }

      if (MOZ_LIKELY(prop.hasSlot())) {
        if (MOZ_LIKELY(prop.slot() == newShape->slotSpan())) {
          obj->setShapeAndRemoveLastSlot(cx, newShape, prop.slot());
          return true;
        }
        // Uncommon case: the property is stored in a reserved slot.
        // See NativeObject::addPropertyInReservedSlot.
        MOZ_ASSERT(prop.slot() < JSCLASS_RESERVED_SLOTS(obj->getClass()));
        obj->setSlot(prop.slot(), UndefinedValue());
      }
      obj->setShape(newShape);
      return true;
    }

    // Removing a non-last property. Switch to dictionary mode and relookup
    // pointers for the new dictionary map.
    if (!NativeObject::toDictionaryMode(cx, obj)) {
      return false;
    }
    map = obj->shape()->propMap();
    if (!PropMap::lookupForRemove(cx, map, mapLength, id, keep,
                                  propMap.address(), &propIndex, &table,
                                  &ptr)) {
      return false;
    }
  } else {
    if (!NativeObject::generateNewDictionaryShape(cx, obj)) {
      return false;
    }
  }

  // The object has a new dictionary shape (see toDictionaryMode and
  // generateNewDictionaryShape calls above), so we can mutate the map and shape
  // in place.

  MOZ_ASSERT(map->isDictionary());
  MOZ_ASSERT(table);
  MOZ_ASSERT(prop == ptr->propertyInfo());

  Rooted<DictionaryPropMap*> dictMap(cx, map->asDictionary());

  // If the property has a slot, free its slot number.
  if (prop.hasSlot()) {
    obj->freeDictionarySlot(prop.slot());
  }

  DictionaryPropMap::removeProperty(cx, &dictMap, &mapLength, table, ptr);

  obj->shape()->updateNewDictionaryShape(obj->shape()->objectFlags(), dictMap,
                                         mapLength);

  // If we just deleted the last property, consider shrinking the slots. We only
  // do this if there are a lot of slots, to avoid allocating/freeing dynamic
  // slots repeatedly.
  static constexpr size_t MinSlotSpanForFree = 64;
  if (obj->dictionaryModeSlotSpan() >= MinSlotSpanForFree) {
    obj->maybeFreeDictionaryPropSlots(cx, dictMap, mapLength);
  }

  return true;
}

/* static */
bool NativeObject::densifySparseElements(JSContext* cx,
                                         Handle<NativeObject*> obj) {
  AutoCheckShapeConsistency check(obj);
  MOZ_ASSERT(obj->inDictionaryMode());

  // First generate a new dictionary shape so that the shape and map can then
  // be updated infallibly.
  if (!NativeObject::generateNewDictionaryShape(cx, obj)) {
    return false;
  }

  Rooted<DictionaryPropMap*> map(cx, obj->shape()->propMap()->asDictionary());
  uint32_t mapLength = obj->shape()->propMapLength();

  DictionaryPropMap::densifyElements(cx, &map, &mapLength, obj);

  // All indexed properties on the object are now dense. Clear the indexed
  // flag so that we will not start using sparse indexes again if we need
  // to grow the object.
  ObjectFlags objectFlags = obj->shape()->objectFlags();
  objectFlags.clearFlag(ObjectFlag::Indexed);

  obj->shape()->updateNewDictionaryShape(objectFlags, map, mapLength);

  obj->maybeFreeDictionaryPropSlots(cx, map, mapLength);

  return true;
}

// static
bool NativeObject::freezeOrSealProperties(JSContext* cx,
                                          Handle<NativeObject*> obj,
                                          IntegrityLevel level) {
  AutoCheckShapeConsistency check(obj);

  if (!Watchtower::watchFreezeOrSeal(cx, obj)) {
    return false;
  }

  uint32_t mapLength = obj->shape()->propMapLength();
  MOZ_ASSERT(mapLength > 0);

  const JSClass* clasp = obj->shape()->getObjectClass();
  ObjectFlags objectFlags = obj->shape()->objectFlags();

  if (obj->inDictionaryMode()) {
    // First generate a new dictionary shape so that the map and shape can be
    // updated infallibly.
    if (!generateNewDictionaryShape(cx, obj)) {
      return false;
    }
    DictionaryPropMap* map = obj->shape()->dictionaryPropMap();
    map->freezeOrSealProperties(cx, level, clasp, mapLength, &objectFlags);
    obj->shape()->updateNewDictionaryShape(objectFlags, map, mapLength);
    return true;
  }

  Rooted<SharedPropMap*> map(cx, obj->shape()->sharedPropMap());
  if (!SharedPropMap::freezeOrSealProperties(cx, level, clasp, &map, mapLength,
                                             &objectFlags)) {
    return false;
  }

  Shape* newShape = SharedShape::getPropMapShape(cx, obj->shape()->base(),
                                                 obj->numFixedSlots(), map,
                                                 mapLength, objectFlags);
  if (!newShape) {
    return false;
  }
  MOZ_ASSERT(obj->shape()->slotSpan() == newShape->slotSpan());

  obj->setShape(newShape);
  return true;
}

/* static */
bool NativeObject::generateNewDictionaryShape(JSContext* cx,
                                              Handle<NativeObject*> obj) {
  // Clone the current dictionary shape to a new shape. This ensures ICs and
  // other shape guards are properly invalidated before we start mutating the
  // map or new shape.

  MOZ_ASSERT(obj->inDictionaryMode());

  Rooted<BaseShape*> base(cx, obj->shape()->base());
  Rooted<DictionaryPropMap*> map(cx, obj->shape()->dictionaryPropMap());
  uint32_t mapLength = obj->shape()->propMapLength();

  Shape* shape =
      DictionaryShape::new_(cx, base, obj->shape()->objectFlags(),
                            obj->shape()->numFixedSlots(), map, mapLength);
  if (!shape) {
    return false;
  }

  obj->setShape(shape);
  return true;
}

/* static */
bool JSObject::setFlag(JSContext* cx, HandleObject obj, ObjectFlag flag) {
  MOZ_ASSERT(cx->compartment() == obj->compartment());

  if (obj->hasFlag(flag)) {
    return true;
  }

  ObjectFlags objectFlags = obj->shape()->objectFlags();
  objectFlags.setFlag(flag);

  if (obj->is<NativeObject>() && obj->as<NativeObject>().inDictionaryMode()) {
    if (!NativeObject::generateNewDictionaryShape(cx, obj.as<NativeObject>())) {
      return false;
    }
    obj->shape()->setObjectFlags(objectFlags);
    return true;
  }

  return Shape::replaceShape(cx, obj, objectFlags, obj->shape()->proto(),
                             obj->shape()->numFixedSlots());
}

/* static */
bool JSObject::setProtoUnchecked(JSContext* cx, HandleObject obj,
                                 Handle<TaggedProto> proto) {
  MOZ_ASSERT(cx->compartment() == obj->compartment());
  MOZ_ASSERT(!obj->staticPrototypeIsImmutable());
  MOZ_ASSERT_IF(!obj->is<ProxyObject>(), obj->nonProxyIsExtensible());
  MOZ_ASSERT(obj->shape()->proto() != proto);

  // Notify Watchtower of this proto change, so it can properly invalidate shape
  // teleporting and other optimizations.
  if (!Watchtower::watchProtoChange(cx, obj)) {
    return false;
  }

  if (proto.isObject() && !proto.toObject()->isUsedAsPrototype()) {
    // Ensure the proto object has a unique id to prevent OOM crashes later on.
    RootedObject protoObj(cx, proto.toObject());
    uint64_t unused;
    if (!cx->zone()->getOrCreateUniqueId(protoObj, &unused)) {
      ReportOutOfMemory(cx);
      return false;
    }

    if (!JSObject::setIsUsedAsPrototype(cx, protoObj)) {
      return false;
    }
  }

  if (obj->is<NativeObject>() && obj->as<NativeObject>().inDictionaryMode()) {
    Handle<NativeObject*> nobj = obj.as<NativeObject>();
    Rooted<BaseShape*> nbase(
        cx, BaseShape::get(cx, nobj->getClass(), nobj->realm(), proto));
    if (!nbase) {
      return false;
    }

    if (!NativeObject::generateNewDictionaryShape(cx, nobj)) {
      return false;
    }

    nobj->shape()->setBase(nbase);
    return true;
  }

  return Shape::replaceShape(cx, obj, obj->shape()->objectFlags(), proto,
                             obj->shape()->numFixedSlots());
}

/* static */
bool NativeObject::changeNumFixedSlotsAfterSwap(JSContext* cx,
                                                Handle<NativeObject*> obj,
                                                uint32_t nfixed) {
  MOZ_ASSERT(nfixed != obj->shape()->numFixedSlots());

  if (obj->inDictionaryMode()) {
    if (!NativeObject::generateNewDictionaryShape(cx, obj)) {
      return false;
    }
    obj->shape()->setNumFixedSlots(nfixed);
    return true;
  }

  return Shape::replaceShape(cx, obj, obj->shape()->objectFlags(),
                             obj->shape()->proto(), nfixed);
}

BaseShape::BaseShape(const JSClass* clasp, JS::Realm* realm, TaggedProto proto)
    : TenuredCellWithNonGCPointer(clasp), realm_(realm), proto_(proto) {
#ifdef DEBUG
  AssertJSClassInvariants(clasp);
#endif

  MOZ_ASSERT_IF(proto.isObject(),
                compartment() == proto.toObject()->compartment());
  MOZ_ASSERT_IF(proto.isObject(), proto.toObject()->isUsedAsPrototype());

  // Windows may not appear on prototype chains.
  MOZ_ASSERT_IF(proto.isObject(), !IsWindow(proto.toObject()));

#ifdef DEBUG
  if (GlobalObject* global = realm->unsafeUnbarrieredMaybeGlobal()) {
    AssertTargetIsNotGray(global);
  }
#endif
}

/* static */
BaseShape* BaseShape::get(JSContext* cx, const JSClass* clasp, JS::Realm* realm,
                          Handle<TaggedProto> proto) {
  auto& table = cx->zone()->shapeZone().baseShapes;

  using Lookup = BaseShapeHasher::Lookup;

  auto p = MakeDependentAddPtr(cx, table, Lookup(clasp, realm, proto));
  if (p) {
    return *p;
  }

  BaseShape* nbase = cx->newCell<BaseShape>(clasp, realm, proto);
  if (!nbase) {
    return nullptr;
  }

  if (!p.add(cx, table, Lookup(clasp, realm, proto), nbase)) {
    return nullptr;
  }

  return nbase;
}

Shape* SharedShape::new_(JSContext* cx, Handle<BaseShape*> base,
                         ObjectFlags objectFlags, uint32_t nfixed,
                         Handle<SharedPropMap*> map, uint32_t mapLength) {
  return cx->newCell<Shape>(base, objectFlags, nfixed, map, mapLength, false);
}

Shape* DictionaryShape::new_(JSContext* cx, Handle<BaseShape*> base,
                             ObjectFlags objectFlags, uint32_t nfixed,
                             Handle<DictionaryPropMap*> map,
                             uint32_t mapLength) {
  return cx->newCell<DictionaryShape>(base, objectFlags, nfixed, map,
                                      mapLength);
}

MOZ_ALWAYS_INLINE HashNumber ShapeForAddHasher::hash(const Lookup& l) {
  HashNumber hash = HashPropertyKey(l.key);
  return mozilla::AddToHash(hash, l.flags.toRaw());
}

MOZ_ALWAYS_INLINE bool ShapeForAddHasher::match(Shape* shape, const Lookup& l) {
  uint32_t slot;
  return shape->lastPropertyMatchesForAdd(l.key, l.flags, &slot);
}

#ifdef DEBUG
void Shape::dump(js::GenericPrinter& out) const {
  out.printf("shape @ 0x%p\n", this);
  out.printf("base: 0x%p\n", base());
  out.printf("mapLength: %u\n", propMapLength());
  out.printf("dictionary: %s\n", isDictionary() ? "yes" : "no");
  if (propMap_) {
    out.printf("map:\n");
    propMap_->dump(out);
  } else {
    out.printf("map: (none)\n");
  }
}

void Shape::dump() const {
  Fprinter out(stderr);
  dump(out);
}
#endif  // DEBUG

/* static */
Shape* SharedShape::getInitialShape(JSContext* cx, const JSClass* clasp,
                                    JS::Realm* realm, TaggedProto proto,
                                    size_t nfixed, ObjectFlags objectFlags) {
  MOZ_ASSERT(cx->compartment() == realm->compartment());
  MOZ_ASSERT_IF(proto.isObject(),
                cx->isInsideCurrentCompartment(proto.toObject()));

  if (proto.isObject()) {
    if (proto.toObject()->isUsedAsPrototype()) {
      // Use the cache on the prototype's shape to get to the initial shape.
      // This cache has a hit rate of 80-90% on typical workloads and is faster
      // than the HashSet lookup below.
      JSObject* protoObj = proto.toObject();
      Shape* protoObjShape = protoObj->shape();
      if (protoObjShape->cache().isShapeWithProto()) {
        Shape* shape = protoObjShape->cache().toShapeWithProto();
        if (shape->numFixedSlots() == nfixed &&
            shape->objectFlags() == objectFlags &&
            shape->getObjectClass() == clasp && shape->realm() == realm &&
            shape->proto() == proto) {
#ifdef DEBUG
          // Verify the table lookup below would have resulted in the same
          // shape.
          using Lookup = InitialShapeHasher::Lookup;
          Lookup lookup(clasp, realm, proto, nfixed, objectFlags);
          auto p = realm->zone()->shapeZone().initialShapes.lookup(lookup);
          MOZ_ASSERT(*p == shape);
#endif
          return shape;
        }
      }
    } else {
      // Ensure the proto object has a unique id to prevent OOM crashes below.
      RootedObject protoObj(cx, proto.toObject());
      uint64_t unused;
      if (!cx->zone()->getOrCreateUniqueId(protoObj, &unused)) {
        ReportOutOfMemory(cx);
        return nullptr;
      }

      if (!JSObject::setIsUsedAsPrototype(cx, protoObj)) {
        return nullptr;
      }
      proto = TaggedProto(protoObj);
    }
  }

  auto& table = realm->zone()->shapeZone().initialShapes;

  using Lookup = InitialShapeHasher::Lookup;
  auto ptr = MakeDependentAddPtr(
      cx, table, Lookup(clasp, realm, proto, nfixed, objectFlags));
  if (ptr) {
    // Cache the result of this lookup on the prototype's shape.
    if (proto.isObject()) {
      JSObject* protoObj = proto.toObject();
      Shape* protoShape = protoObj->shape();
      if (!protoShape->cache().isForAdd() &&
          RegisterShapeCache(cx, protoShape)) {
        protoShape->cacheRef().setShapeWithProto(*ptr);
      }
    }
    return *ptr;
  }

  Rooted<TaggedProto> protoRoot(cx, proto);
  Rooted<BaseShape*> nbase(cx, BaseShape::get(cx, clasp, realm, protoRoot));
  if (!nbase) {
    return nullptr;
  }

  Rooted<Shape*> shape(
      cx, SharedShape::new_(cx, nbase, objectFlags, nfixed, nullptr, 0));
  if (!shape) {
    return nullptr;
  }

  Lookup lookup(clasp, realm, protoRoot, nfixed, objectFlags);
  if (!ptr.add(cx, table, lookup, shape)) {
    return nullptr;
  }

  return shape;
}

/* static */
Shape* SharedShape::getInitialShape(JSContext* cx, const JSClass* clasp,
                                    JS::Realm* realm, TaggedProto proto,
                                    gc::AllocKind kind,
                                    ObjectFlags objectFlags) {
  return getInitialShape(cx, clasp, realm, proto, GetGCKindSlots(kind),
                         objectFlags);
}

/* static */
Shape* SharedShape::getPropMapShape(JSContext* cx, BaseShape* base,
                                    size_t nfixed, Handle<SharedPropMap*> map,
                                    uint32_t mapLength, ObjectFlags objectFlags,
                                    bool* allocatedNewShape) {
  MOZ_ASSERT(cx->compartment() == base->compartment());
  MOZ_ASSERT_IF(base->proto().isObject(),
                cx->isInsideCurrentCompartment(base->proto().toObject()));
  MOZ_ASSERT_IF(base->proto().isObject(),
                base->proto().toObject()->isUsedAsPrototype());
  MOZ_ASSERT(map);
  MOZ_ASSERT(mapLength > 0);

  auto& table = cx->zone()->shapeZone().propMapShapes;

  using Lookup = PropMapShapeHasher::Lookup;
  auto ptr = MakeDependentAddPtr(
      cx, table, Lookup(base, nfixed, map, mapLength, objectFlags));
  if (ptr) {
    if (allocatedNewShape) {
      *allocatedNewShape = false;
    }
    return *ptr;
  }

  Rooted<BaseShape*> baseRoot(cx, base);
  Rooted<Shape*> shape(
      cx, SharedShape::new_(cx, baseRoot, objectFlags, nfixed, map, mapLength));
  if (!shape) {
    return nullptr;
  }

  Lookup lookup(baseRoot, nfixed, map, mapLength, objectFlags);
  if (!ptr.add(cx, table, lookup, shape)) {
    return nullptr;
  }

  if (allocatedNewShape) {
    *allocatedNewShape = true;
  }

  return shape;
}

/* static */
Shape* SharedShape::getInitialOrPropMapShape(
    JSContext* cx, const JSClass* clasp, JS::Realm* realm, TaggedProto proto,
    size_t nfixed, Handle<SharedPropMap*> map, uint32_t mapLength,
    ObjectFlags objectFlags) {
  if (!map) {
    MOZ_ASSERT(mapLength == 0);
    return getInitialShape(cx, clasp, realm, proto, nfixed, objectFlags);
  }

  Rooted<TaggedProto> protoRoot(cx, proto);
  BaseShape* nbase = BaseShape::get(cx, clasp, realm, protoRoot);
  if (!nbase) {
    return nullptr;
  }

  return getPropMapShape(cx, nbase, nfixed, map, mapLength, objectFlags);
}

/* static */
void SharedShape::insertInitialShape(JSContext* cx, Handle<Shape*> shape) {
  using Lookup = InitialShapeHasher::Lookup;
  Lookup lookup(shape->getObjectClass(), shape->realm(), shape->proto(),
                shape->numFixedSlots(), shape->objectFlags());

  auto& table = cx->zone()->shapeZone().initialShapes;
  InitialShapeSet::Ptr p = table.lookup(lookup);
  MOZ_ASSERT(p);

  // The metadata callback can end up causing redundant changes of the initial
  // shape.
  Shape* initialShape = *p;
  if (initialShape == shape) {
    return;
  }

  MOZ_ASSERT(initialShape->numFixedSlots() == shape->numFixedSlots());
  MOZ_ASSERT(initialShape->base() == shape->base());
  MOZ_ASSERT(initialShape->objectFlags() == shape->objectFlags());

  table.replaceKey(p, lookup, shape.get());

  // Purge the prototype's shape cache entry.
  if (shape->proto().isObject()) {
    JSObject* protoObj = shape->proto().toObject();
    if (protoObj->shape()->cache().isShapeWithProto()) {
      protoObj->shape()->cacheRef().setNone();
    }
  }
}

JS::ubi::Node::Size JS::ubi::Concrete<js::Shape>::size(
    mozilla::MallocSizeOf mallocSizeOf) const {
  Size size = js::gc::Arena::thingSize(get().asTenured().getAllocKind());

  if (get().cache().isShapeSetForAdd()) {
    ShapeSetForAdd* set = get().cache().toShapeSetForAdd();
    size += set->shallowSizeOfIncludingThis(mallocSizeOf);
  }

  return size;
}

JS::ubi::Node::Size JS::ubi::Concrete<js::BaseShape>::size(
    mozilla::MallocSizeOf mallocSizeOf) const {
  return js::gc::Arena::thingSize(get().asTenured().getAllocKind());
}
