/* -*- Mode: C++; tab-width: 8; indent-tabs-mode: nil; c-basic-offset: 2 -*-
 * vim: set ts=8 sts=2 et sw=2 tw=80:
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#ifndef gc_GCMarker_h
#define gc_GCMarker_h

#include "mozilla/Maybe.h"
#include "mozilla/Variant.h"

#include "ds/OrderedHashTable.h"
#include "gc/Barrier.h"
#include "js/TracingAPI.h"
#include "js/TypeDecls.h"

class JSRope;

namespace js {

class GCMarker;
class SliceBudget;
class WeakMapBase;

static const size_t MARK_STACK_BASE_CAPACITY = 4096;

enum class SlotsOrElementsKind { Elements, FixedSlots, DynamicSlots };

namespace gc {

enum IncrementalProgress { NotFinished = 0, Finished };

class AutoSetMarkColor;
struct Cell;

struct EphemeronEdgeTableHashPolicy {
  using Lookup = Cell*;
  static HashNumber hash(const Lookup& v,
                         const mozilla::HashCodeScrambler& hcs) {
    return hcs.scramble(mozilla::HashGeneric(v));
  }
  static bool match(Cell* const& k, const Lookup& l) { return k == l; }
  static bool isEmpty(Cell* const& v) { return !v; }
  static void makeEmpty(Cell** vp) { *vp = nullptr; }
};

// Ephemeron edges have two source nodes and one target, and mark the target
// with the minimum (least-marked) color of the sources. Currently, one of
// those sources will always be a WeakMapBase, so this will refer to its color
// at the time the edge is traced through. The other source's color will be
// given by the current mark color of the GCMarker.
struct EphemeronEdge {
  CellColor color;
  Cell* target;

  EphemeronEdge(CellColor color_, Cell* cell) : color(color_), target(cell) {}
};

using EphemeronEdgeVector = Vector<EphemeronEdge, 2, js::SystemAllocPolicy>;

using EphemeronEdgeTable =
    OrderedHashMap<Cell*, EphemeronEdgeVector, EphemeronEdgeTableHashPolicy,
                   js::SystemAllocPolicy>;

/*
 * The mark stack. Pointers in this stack are "gray" in the GC sense, but
 * their references may be marked either black or gray (in the CC sense)
 * depending on whether they are above or below grayPosition_.
 *
 * When the mark stack is full, the GC does not call js::TraceChildren to mark
 * the reachable "children" of the thing. Rather the thing is put aside and
 * js::TraceChildren is called later when the mark stack is empty.
 *
 * To implement such delayed marking of the children with minimal overhead for
 * the normal case of sufficient stack, we link arenas into a list using
 * Arena::setNextDelayedMarkingArena(). The head of the list is stored in
 * GCMarker::delayedMarkingList. GCMarker::delayMarkingChildren() adds arenas
 * to the list as necessary while markAllDelayedChildren() pops the arenas from
 * the stack until it is empty.
 */
class MarkStack {
 public:
  /*
   * We use a common mark stack to mark GC things of different types and use
   * the explicit tags to distinguish them when it cannot be deduced from
   * the context of push or pop operation.
   */
  enum Tag {
    SlotsOrElementsRangeTag,
    ObjectTag,
    JitCodeTag,
    ScriptTag,
    TempRopeTag,

    LastTag = TempRopeTag
  };

  static const uintptr_t TagMask = 7;
  static_assert(TagMask >= uintptr_t(LastTag),
                "The tag mask must subsume the tags.");
  static_assert(TagMask <= gc::CellAlignMask,
                "The tag mask must be embeddable in a Cell*.");

  class TaggedPtr {
    uintptr_t bits;

    Cell* ptr() const;

   public:
    TaggedPtr() = default;
    TaggedPtr(Tag tag, Cell* ptr);
    Tag tag() const;
    template <typename T>
    T* as() const;

    JSObject* asRangeObject() const;
    JSRope* asTempRope() const;

    void assertValid() const;
  };

  struct SlotsOrElementsRange {
    SlotsOrElementsRange(SlotsOrElementsKind kind, JSObject* obj, size_t start);
    void assertValid() const;

    SlotsOrElementsKind kind() const;
    size_t start() const;
    TaggedPtr ptr() const;

    static constexpr size_t StartShift = 2;
    static constexpr size_t KindMask = (1 << StartShift) - 1;

   private:
    uintptr_t startAndKind_;
    TaggedPtr ptr_;
  };

  explicit MarkStack();
  ~MarkStack();

  // The unit for MarkStack::capacity() is mark stack entries.
  size_t capacity() { return stack().length(); }

  size_t position() const { return topIndex_; }

  [[nodiscard]] bool init();
  [[nodiscard]] bool resetStackCapacity();

#ifdef JS_GC_ZEAL
  void setMaxCapacity(size_t maxCapacity);
#endif

  void setMarkColor(MarkColor newColor);
  MarkColor markColor() const { return markColor_; }

  bool hasBlackEntries() const { return position() > grayPosition_; }
  bool hasGrayEntries() const { return grayPosition_ > 0 && !isEmpty(); }
  bool hasEntries(MarkColor color) const;

  template <typename T>
  [[nodiscard]] bool push(T* ptr);

  [[nodiscard]] bool push(JSObject* obj, SlotsOrElementsKind kind,
                          size_t start);
  [[nodiscard]] bool push(const SlotsOrElementsRange& array);

  // GCMarker::eagerlyMarkChildren uses unused marking stack as temporary
  // storage to hold rope pointers.
  [[nodiscard]] bool pushTempRope(JSRope* ptr);

  bool isEmpty() const { return topIndex_ == 0; }

  Tag peekTag() const;
  TaggedPtr popPtr();
  SlotsOrElementsRange popSlotsOrElementsRange();

  void clear();

  void poisonUnused();

  size_t sizeOfExcludingThis(mozilla::MallocSizeOf mallocSizeOf) const;

 private:
  using StackVector = Vector<TaggedPtr, 0, SystemAllocPolicy>;
  const StackVector& stack() const { return stack_.ref(); }
  StackVector& stack() { return stack_.ref(); }

  [[nodiscard]] bool ensureSpace(size_t count);

  /* Grow the stack, ensuring there is space for at least count elements. */
  [[nodiscard]] bool enlarge(size_t count);

  [[nodiscard]] bool resize(size_t newCapacity);

  TaggedPtr* topPtr();

  const TaggedPtr& peekPtr() const;
  [[nodiscard]] bool pushTaggedPtr(Tag tag, Cell* ptr);

  void assertGrayPositionValid() const;

  // Vector containing allocated stack memory. Unused beyond topIndex_.
  MainThreadOrGCTaskData<StackVector> stack_;

  // Index of the top of the stack.
  MainThreadOrGCTaskData<size_t> topIndex_;

  // Stack entries at positions below this are considered gray.
  MainThreadOrGCTaskData<size_t> grayPosition_;

  // The current mark color. This is only applied to objects and functions.
  MainThreadOrGCTaskData<gc::MarkColor> markColor_;

#ifdef JS_GC_ZEAL
  // The maximum stack capacity to grow to.
  MainThreadOrGCTaskData<size_t> maxCapacity_{SIZE_MAX};
#endif

#ifdef DEBUG
  mutable size_t iteratorCount_ = 0;
#endif
};

// Bitmask of options to parameterize MarkingTracerT.
namespace MarkingOptions {
enum : uint32_t {
  None = 0,

  // Set the compartment's hasMarkedCells flag for roots.
  MarkRootCompartments = 1
};
}  // namespace MarkingOptions

template <uint32_t markingOptions>
class MarkingTracerT
    : public GenericTracerImpl<MarkingTracerT<markingOptions>> {
 public:
  explicit MarkingTracerT(JSRuntime* runtime);
  virtual ~MarkingTracerT() = default;

  template <typename T>
  void onEdge(T** thingp, const char* name);
  friend class GenericTracerImpl<MarkingTracerT<markingOptions>>;

  GCMarker* getMarker();
};

using MarkingTracer = MarkingTracerT<MarkingOptions::None>;
using RootMarkingTracer = MarkingTracerT<MarkingOptions::MarkRootCompartments>;

} /* namespace gc */

class GCMarker {
  enum MarkingState : uint8_t {
    // Have not yet started marking.
    NotActive,

    // Root marking mode. This sets the hasMarkedCells flag on compartments
    // containing objects and scripts, which is used to make sure we clean up
    // dead compartments.
    RootMarking,

    // Main marking mode. Weakmap marking will be populating the
    // gcEphemeronEdges tables but not consulting them. The state will
    // transition to WeakMarking until it is done, then back to RegularMarking.
    RegularMarking,

    // Same as RegularMarking except now every marked obj/script is immediately
    // looked up in the gcEphemeronEdges table to find edges generated by
    // weakmap keys, and traversing them to their values. Transitions back to
    // RegularMarking when done.
    WeakMarking,
  };

 public:
  explicit GCMarker(JSRuntime* rt);
  [[nodiscard]] bool init();

  JSRuntime* runtime() { return runtime_; }
  JSTracer* tracer() {
    return tracer_.match([](auto& t) -> JSTracer* { return &t; });
  }

#ifdef JS_GC_ZEAL
  void setMaxCapacity(size_t maxCap) { stack.setMaxCapacity(maxCap); }
#endif

  bool isActive() const { return state != NotActive; }
  bool isRegularMarking() const { return state == RegularMarking; }
  bool isWeakMarking() const { return state == WeakMarking; }

  gc::MarkColor markColor() const { return stack.markColor(); }

  bool isDrained();

  void start();
  void stop();
  void reset();

  enum ShouldReportMarkTime : bool {
    ReportMarkTime = true,
    DontReportMarkTime = false
  };
  [[nodiscard]] bool markUntilBudgetExhausted(
      SliceBudget& budget, ShouldReportMarkTime reportTime = ReportMarkTime);

  void setRootMarkingMode(bool newState);

  bool enterWeakMarkingMode();
  void leaveWeakMarkingMode();

  // Do not use linear-time weak marking for the rest of this collection.
  // Currently, this will only be triggered by an OOM when updating needed data
  // structures.
  void abortLinearWeakMarking();

  // 'delegate' is no longer the delegate of 'key'.
  void severWeakDelegate(JSObject* key, JSObject* delegate);

  // 'delegate' is now the delegate of 'key'. Update weakmap marking state.
  void restoreWeakDelegate(JSObject* key, JSObject* delegate);

#ifdef DEBUG
  // We can't check atom marking if the helper thread lock is already held by
  // the current thread. This allows us to disable the check.
  void setCheckAtomMarking(bool check);

  bool shouldCheckCompartments() { return strictCompartmentChecking; }
#endif

  size_t sizeOfExcludingThis(mozilla::MallocSizeOf mallocSizeOf) const;

  static GCMarker* fromTracer(JSTracer* trc) {
    MOZ_ASSERT(trc->isMarkingTracer());
    auto* marker = reinterpret_cast<GCMarker*>(uintptr_t(trc) -
                                               offsetof(GCMarker, tracer_));
    MOZ_ASSERT(marker->tracer() == trc);
    return marker;
  }

  // Internal public methods, for ease of use by the rest of the GC:

  // If |thing| is unmarked, mark it and then traverse its children.
  template <uint32_t = gc::MarkingOptions::None, typename T>
  void markAndTraverse(T* thing);

  template <typename T>
  void markImplicitEdges(T* oldThing);

 private:
  /*
   * Care must be taken changing the mark color from gray to black. The cycle
   * collector depends on the invariant that there are no black to gray edges
   * in the GC heap. This invariant lets the CC not trace through black
   * objects. If this invariant is violated, the cycle collector may free
   * objects that are still reachable.
   */
  void setMarkColor(gc::MarkColor newColor) { stack.setMarkColor(newColor); }
  friend class js::gc::AutoSetMarkColor;

  bool isMarkStackEmpty() const { return stack.isEmpty(); }
  bool hasBlackEntries() const { return stack.hasBlackEntries(); }
  bool hasGrayEntries() const { return stack.hasGrayEntries(); }

  void processMarkStackTop(SliceBudget& budget);
  friend class gc::GCRuntime;

  // Helper methods that coerce their second argument to the base pointer
  // type.
  template <typename S>
  void markAndTraverseObjectEdge(S source, JSObject* target) {
    markAndTraverseEdge(source, target);
  }
  template <typename S>
  void markAndTraverseStringEdge(S source, JSString* target) {
    markAndTraverseEdge(source, target);
  }

  // Calls traverse on target after making additional assertions.
  template <typename S, typename T>
  void markAndTraverseEdge(S source, T* target);
  template <typename S, typename T>
  void markAndTraverseEdge(S source, const T& target);

  template <typename S, typename T>
  void checkTraversedEdge(S source, T* target);

  // Mark the given GC thing, but do not trace its children. Return true
  // if the thing became marked.
  template <typename T>
  [[nodiscard]] bool mark(T* thing);

  // Traverse a GC thing's children, using a strategy depending on the type.
  // This can either processing them immediately or push them onto the mark
  // stack for later.
  template <typename T>
  void traverse(T* thing);

  // Process a marked thing's children by calling T::traceChildren().
  template <typename T>
  void traceChildren(T* thing);

  // Process a marked thing's children recursively using an iterative loop and
  // manual dispatch, for kinds where this is possible.
  template <typename T>
  void scanChildren(T* thing);

  // Push a marked thing onto the mark stack. Its children will be marked later.
  template <typename T>
  void pushThing(T* thing);

  void eagerlyMarkChildren(JSLinearString* str);
  void eagerlyMarkChildren(JSRope* rope);
  void eagerlyMarkChildren(JSString* str);
  void eagerlyMarkChildren(Shape* shape);
  void eagerlyMarkChildren(PropMap* map);
  void eagerlyMarkChildren(Scope* scope);

  template <typename T>
  inline void pushTaggedPtr(T* ptr);

  inline void pushValueRange(JSObject* obj, SlotsOrElementsKind kind,
                             size_t start, size_t end);

  // Push an object onto the stack for later tracing and assert that it has
  // already been marked.
  inline void repush(JSObject* obj);

  template <typename T>
  void markImplicitEdgesHelper(T oldThing);

  // Mark through edges whose target color depends on the colors of two source
  // entities (eg a WeakMap and one of its keys), and push the target onto the
  // mark stack.
  void markEphemeronEdges(gc::EphemeronEdgeVector& edges,
                          gc::CellColor srcColor);
  friend class JS::Zone;

#ifdef DEBUG
  void checkZone(void* p);
#else
  void checkZone(void* p) {}
#endif

  void delayMarkingChildrenOnOOM(gc::Cell* cell);
  void delayMarkingChildren(gc::Cell* cell);

  void markDelayedChildren(gc::Arena* arena);
  void markAllDelayedChildren(ShouldReportMarkTime reportTime);
  void processDelayedMarkingList(gc::MarkColor color);
  bool hasDelayedChildren() const { return !!delayedMarkingList; }
  void rebuildDelayedMarkingList();
  void appendToDelayedMarkingList(gc::Arena** listTail, gc::Arena* arena);

  template <typename F>
  void forEachDelayedMarkingArena(F&& f);

  /*
   * The JSTracer used for marking. This can change depending on the current
   * state.
   */
  mozilla::Variant<gc::MarkingTracer, gc::RootMarkingTracer> tracer_;

  JSRuntime* const runtime_;

  /* The stack of remaining marking work . */
  gc::MarkStack stack;

  /* Pointer to the top of the stack of arenas we are delaying marking on. */
  MainThreadOrGCTaskData<js::gc::Arena*> delayedMarkingList;

  /* Whether more work has been added to the delayed marking list. */
  MainThreadOrGCTaskData<bool> delayedMarkingWorkAdded;

  /* Whether we successfully added all edges to the implicit edges table. */
  MainThreadOrGCTaskData<bool> haveAllImplicitEdges;

  /* Track the state of marking. */
  MainThreadOrGCTaskData<MarkingState> state;

 public:
  /*
   * Whether weakmaps can be marked incrementally.
   *
   * JSGC_INCREMENTAL_WEAKMAP_ENABLED
   * pref: javascript.options.mem.incremental_weakmap
   */
  MainThreadOrGCTaskData<bool> incrementalWeakMapMarkingEnabled;

#ifdef DEBUG
 private:
  /* Count of arenas that are currently in the stack. */
  MainThreadOrGCTaskData<size_t> markLaterArenas;

  /* Assert that start and stop are called with correct ordering. */
  MainThreadOrGCTaskData<bool> started;

  /*
   * Whether to check that atoms traversed are present in atom marking
   * bitmap.
   */
  MainThreadOrGCTaskData<bool> checkAtomMarking;

  /*
   * If this is true, all marked objects must belong to a compartment being
   * GCed. This is used to look for compartment bugs.
   */
  MainThreadOrGCTaskData<bool> strictCompartmentChecking;

 public:
  /*
   * The compartment and zone of the object whose trace hook is currently being
   * called, if any. Used to catch cross-compartment edges traced without use of
   * TraceCrossCompartmentEdge.
   */
  MainThreadOrGCTaskData<Compartment*> tracingCompartment;
  MainThreadOrGCTaskData<Zone*> tracingZone;
#endif  // DEBUG
};

namespace gc {

/*
 * Temporarily change the mark color while this class is on the stack.
 *
 * During incremental sweeping this also transitions zones in the
 * current sweep group into the Mark or MarkGray state as appropriate.
 */
class MOZ_RAII AutoSetMarkColor {
  GCMarker& marker_;
  MarkColor initialColor_;

 public:
  AutoSetMarkColor(GCMarker& marker, MarkColor newColor)
      : marker_(marker), initialColor_(marker.markColor()) {
    marker_.setMarkColor(newColor);
  }

  AutoSetMarkColor(GCMarker& marker, CellColor newColor)
      : AutoSetMarkColor(marker, newColor.asMarkColor()) {}

  ~AutoSetMarkColor() { marker_.setMarkColor(initialColor_); }
};

} /* namespace gc */

} /* namespace js */

#endif /* gc_GCMarker_h */
