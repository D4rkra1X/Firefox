/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { XPCOMUtils } from "resource://gre/modules/XPCOMUtils.sys.mjs";

const lazy = {};

ChromeUtils.defineESModuleGetters(lazy, {
  L10nCache: "resource:///modules/UrlbarUtils.sys.mjs",
  UrlbarPrefs: "resource:///modules/UrlbarPrefs.sys.mjs",
  UrlbarProviderTopSites: "resource:///modules/UrlbarProviderTopSites.sys.mjs",
  UrlbarProvidersManager: "resource:///modules/UrlbarProvidersManager.sys.mjs",
  UrlbarSearchOneOffs: "resource:///modules/UrlbarSearchOneOffs.sys.mjs",
  UrlbarTokenizer: "resource:///modules/UrlbarTokenizer.sys.mjs",
  UrlbarUtils: "resource:///modules/UrlbarUtils.sys.mjs",
});

XPCOMUtils.defineLazyModuleGetters(lazy, {
  BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.jsm",
  ObjectUtils: "resource://gre/modules/ObjectUtils.jsm",
});

XPCOMUtils.defineLazyServiceGetter(
  lazy,
  "styleSheetService",
  "@mozilla.org/content/style-sheet-service;1",
  "nsIStyleSheetService"
);

// Query selector for selectable elements in tip and dynamic results.
const SELECTABLE_ELEMENT_SELECTOR = "[role=button], [selectable=true]";

// Query selector that prevents rows from being selectable.
const UNSELECTABLE_ELEMENT_SELECTOR = "[selectable=false]";

const getBoundsWithoutFlushing = element =>
  element.ownerGlobal.windowUtils.getBoundsWithoutFlushing(element);

// Used to get a unique id to use for row elements, it wraps at 9999, that
// should be plenty for our needs.
let gUniqueIdSerial = 1;
function getUniqueId(prefix) {
  return prefix + (gUniqueIdSerial++ % 9999);
}

/**
 * Receives and displays address bar autocomplete results.
 */
export class UrlbarView {
  // Stale rows are removed on a timer with this timeout.
  static removeStaleRowsTimeout = 400;

  /**
   * @param {UrlbarInput} input
   *   The UrlbarInput instance belonging to this UrlbarView instance.
   */
  constructor(input) {
    this.input = input;
    this.panel = input.panel;
    this.controller = input.controller;
    this.document = this.panel.ownerDocument;
    this.window = this.document.defaultView;

    this.#mainContainer = this.panel.querySelector(".urlbarView-body-inner");
    this.#rows = this.panel.querySelector(".urlbarView-results");
    this.#resultMenu = this.panel.querySelector(".urlbarView-result-menu");

    this.#rows.addEventListener("mousedown", this);

    // For the horizontal fade-out effect, set the overflow attribute on result
    // rows when they overflow.
    this.#rows.addEventListener("overflow", this);
    this.#rows.addEventListener("underflow", this);

    this.#resultMenu.addEventListener("command", this);

    // `noresults` is used to style the one-offs without their usual top border
    // when no results are present.
    this.panel.setAttribute("noresults", "true");

    this.controller.setView(this);
    this.controller.addQueryListener(this);
    // This is used by autoOpen to avoid flickering results when reopening
    // previously abandoned searches.
    this.queryContextCache = new QueryContextCache(5);

    // We cache l10n strings to avoid Fluent's async lookup.
    this.#l10nCache = new lazy.L10nCache(this.document.l10n);

    for (let viewTemplate of UrlbarView.dynamicViewTemplatesByName.values()) {
      if (viewTemplate.stylesheet) {
        addDynamicStylesheet(this.window, viewTemplate.stylesheet);
      }
    }
  }

  get oneOffSearchButtons() {
    if (!this.#oneOffSearchButtons) {
      this.#oneOffSearchButtons = new lazy.UrlbarSearchOneOffs(this);
      this.#oneOffSearchButtons.addEventListener(
        "SelectedOneOffButtonChanged",
        this
      );
    }
    return this.#oneOffSearchButtons;
  }

  /**
   * Whether the panel is open.
   *
   * @returns {boolean}
   */
  get isOpen() {
    return this.input.hasAttribute("open");
  }

  get allowEmptySelection() {
    let { heuristicResult } = this.#queryContext || {};
    return !heuristicResult || !this.#shouldShowHeuristic(heuristicResult);
  }

  get selectedRowIndex() {
    if (!this.isOpen) {
      return -1;
    }

    let selectedRow = this.#getSelectedRow();

    if (!selectedRow) {
      return -1;
    }

    return selectedRow.result.rowIndex;
  }

  set selectedRowIndex(val) {
    if (!this.isOpen) {
      throw new Error(
        "UrlbarView: Cannot select an item if the view isn't open."
      );
    }

    if (val < 0) {
      this.#selectElement(null);
      return;
    }

    let items = Array.from(this.#rows.children).filter(r =>
      this.#isElementVisible(r)
    );
    if (val >= items.length) {
      throw new Error(`UrlbarView: Index ${val} is out of bounds.`);
    }
    this.#selectElement(items[val]);
  }

  get selectedElementIndex() {
    if (!this.isOpen || !this.#selectedElement) {
      return -1;
    }

    return this.#selectedElement.elementIndex;
  }

  set selectedElementIndex(val) {
    if (!this.isOpen) {
      throw new Error(
        "UrlbarView: Cannot select an item if the view isn't open."
      );
    }

    if (val < 0) {
      this.#selectElement(null);
      return;
    }

    let selectableElement = this.#getFirstSelectableElement();
    while (selectableElement && selectableElement.elementIndex != val) {
      selectableElement = this.#getNextSelectableElement(selectableElement);
    }

    if (!selectableElement) {
      throw new Error(`UrlbarView: Index ${val} is out of bounds.`);
    }

    this.#selectElement(selectableElement);
  }

  /**
   * @returns {UrlbarResult}
   *   The currently selected result.
   */
  get selectedResult() {
    if (!this.isOpen) {
      return null;
    }

    return this.#getSelectedRow()?.result;
  }

  /**
   * @returns {Element}
   *   The currently selected element.
   */
  get selectedElement() {
    if (!this.isOpen) {
      return null;
    }

    return this.#selectedElement;
  }

  /**
   * Clears selection, regardless of view status.
   */
  clearSelection() {
    this.#selectElement(null, { updateInput: false });
  }

  /**
   * @returns {number}
   *   The number of visible results in the view.  Note that this may be larger
   *   than the number of results in the current query context since the view
   *   may be showing stale results.
   */
  get visibleRowCount() {
    let sum = 0;
    for (let row of this.#rows.children) {
      sum += Number(this.#isElementVisible(row));
    }
    return sum;
  }

  /**
   * @returns {number}
   *   The number of selectable elements in the view.
   */
  get visibleElementCount() {
    let sum = 0;
    let element = this.#getFirstSelectableElement();
    while (element) {
      if (this.#isElementVisible(element)) {
        sum++;
      }
      element = this.#getNextSelectableElement(element);
    }
    return sum;
  }

  /**
   * Returns the result of the row containing the given element, or the result
   * of the element if it itself is a row.
   *
   * @param {Element} element
   *   An element in the view.
   * @returns {UrlbarResult}
   *   The result of the element's row.
   */
  getResultFromElement(element) {
    if (!this.isOpen) {
      return null;
    }

    let row = this.#getRowFromElement(element);

    if (!row) {
      return null;
    }

    return row.result;
  }

  /**
   * @param {number} index
   *   The index from which to fetch the result.
   * @returns {UrlbarResult}
   *   The result at `index`. Null if the view is closed or if there are no
   *   results.
   */
  getResultAtIndex(index) {
    if (
      !this.isOpen ||
      !this.#rows.children.length ||
      index >= this.#rows.children.length
    ) {
      return null;
    }

    return this.#rows.children[index].result;
  }

  /**
   * @param {UrlbarResult} result A result.
   * @returns {boolean} True if the given result is selected.
   */
  resultIsSelected(result) {
    if (this.selectedRowIndex < 0) {
      return false;
    }

    return result.rowIndex == this.selectedRowIndex;
  }

  /**
   * Moves the view selection forward or backward.
   *
   * @param {number} amount
   *   The number of steps to move.
   * @param {object} options Options object
   * @param {boolean} [options.reverse]
   *   Set to true to select the previous item. By default the next item
   *   will be selected.
   * @param {boolean} [options.userPressedTab]
   *   Set to true if the user pressed Tab to select a result. Default false.
   */
  selectBy(amount, { reverse = false, userPressedTab = false } = {}) {
    if (!this.isOpen) {
      throw new Error(
        "UrlbarView: Cannot select an item if the view isn't open."
      );
    }

    // Do not set aria-activedescendant if the user is moving to a
    // tab-to-search result with the Tab key. If
    // accessibility.tabToSearch.announceResults is set, the tab-to-search
    // result was announced to the user as they typed. We don't set
    // aria-activedescendant so the user doesn't think they have to press
    // Enter to enter search mode. See bug 1647929.
    const isSkippableTabToSearchAnnounce = selectedElt => {
      let skipAnnouncement =
        selectedElt?.result?.providerName == "TabToSearch" &&
        !this.#announceTabToSearchOnSelection &&
        userPressedTab &&
        lazy.UrlbarPrefs.get("accessibility.tabToSearch.announceResults");
      if (skipAnnouncement) {
        // Once we skip setting aria-activedescendant once, we should not skip
        // it again if the user returns to that result.
        this.#announceTabToSearchOnSelection = true;
      }
      return skipAnnouncement;
    };

    // Freeze results as the user is interacting with them, unless we are
    // deferring events while waiting for critical results.
    if (!this.input.eventBufferer.isDeferringEvents) {
      this.controller.cancelQuery();
    }

    let selectedElement = this.#selectedElement;

    // We cache the first and last rows since they will not change while
    // selectBy is running.
    let firstSelectableElement = this.#getFirstSelectableElement();
    // #getLastSelectableElement will not return an element that is over
    // maxResults and thus may be hidden and not selectable.
    let lastSelectableElement = this.#getLastSelectableElement();

    if (!selectedElement) {
      selectedElement = reverse
        ? lastSelectableElement
        : firstSelectableElement;
      this.#selectElement(selectedElement, {
        setAccessibleFocus: !isSkippableTabToSearchAnnounce(selectedElement),
      });
      return;
    }
    let endReached = reverse
      ? selectedElement == firstSelectableElement
      : selectedElement == lastSelectableElement;
    if (endReached) {
      if (this.allowEmptySelection) {
        selectedElement = null;
      } else {
        selectedElement = reverse
          ? lastSelectableElement
          : firstSelectableElement;
      }
      this.#selectElement(selectedElement, {
        setAccessibleFocus: !isSkippableTabToSearchAnnounce(selectedElement),
      });
      return;
    }

    while (amount-- > 0) {
      let next = reverse
        ? this.#getPreviousSelectableElement(selectedElement)
        : this.#getNextSelectableElement(selectedElement);
      if (!next) {
        break;
      }
      if (!this.#isElementVisible(next)) {
        continue;
      }
      selectedElement = next;
    }
    this.#selectElement(selectedElement, {
      setAccessibleFocus: !isSkippableTabToSearchAnnounce(selectedElement),
    });
  }

  removeAccessibleFocus() {
    this.#setAccessibleFocus(null);
  }

  clear() {
    this.#rows.textContent = "";
    this.panel.setAttribute("noresults", "true");
    this.clearSelection();
  }

  /**
   * Closes the view, cancelling the query if necessary.
   *
   * @param {object} options Options object
   * @param {boolean} [options.elementPicked]
   *   True if the view is being closed because a result was picked.
   * @param {boolean} [options.showFocusBorder]
   *   True if the Urlbar focus border should be shown after the view is closed.
   */
  close({ elementPicked = false, showFocusBorder = true } = {}) {
    this.controller.cancelQuery();
    // We do not show the focus border when an element is picked because we'd
    // flash it just before the input is blurred. The focus border is removed
    // in UrlbarInput._on_blur.
    if (!elementPicked && showFocusBorder) {
      this.input.removeAttribute("suppress-focus-border");
    }

    if (!this.isOpen) {
      return;
    }

    // We exit search mode preview on close since the result previewing it is
    // implicitly unselected.
    if (this.input.searchMode?.isPreview) {
      this.input.searchMode = null;
    }

    this.removeAccessibleFocus();
    this.input.inputField.setAttribute("aria-expanded", "false");
    this.#openPanelInstance = null;
    this.#previousTabToSearchEngine = null;

    this.input.removeAttribute("open");
    this.input.endLayoutExtend();

    // Search Tips can open the view without the Urlbar being focused. If the
    // tip is ignored (e.g. the page content is clicked or the window loses
    // focus) we should discard the telemetry event created when the view was
    // opened.
    if (!this.input.focused && !elementPicked) {
      this.controller.engagementEvent.discard();
      this.controller.engagementEvent.record(null, {});
    }

    this.window.removeEventListener("resize", this);
    this.window.removeEventListener("blur", this);

    this.controller.notify(this.controller.NOTIFICATIONS.VIEW_CLOSE);
  }

  /**
   * This can be used to open the view automatically as a consequence of
   * specific user actions. For Top Sites searches (without a search string)
   * the view is opened only for mouse or keyboard interactions.
   * If the user abandoned a search (there is a search string) the view is
   * reopened, and we try to use cached results to reduce flickering, then a new
   * query is started to refresh results.
   *
   * @param {object} options Options object
   * @param {Event} options.event The event associated with the call to autoOpen.
   * @param {boolean} [options.suppressFocusBorder] If true, we hide the focus border
   *        when the panel is opened. This is true by default to avoid flashing
   *        the border when the unfocused address bar is clicked.
   * @returns {boolean} Whether the view was opened.
   */
  autoOpen({ event, suppressFocusBorder = true }) {
    if (this.#pickSearchTipIfPresent(event)) {
      return false;
    }

    if (!event) {
      return false;
    }

    let queryOptions = { event };

    if (
      !this.input.value ||
      this.input.getAttribute("pageproxystate") == "valid"
    ) {
      if (!this.isOpen && ["mousedown", "command"].includes(event.type)) {
        // Try to reuse the cached top-sites context. If it's not cached, then
        // there will be a gap of time between when the input is focused and
        // when the view opens that can be perceived as flicker.
        if (!this.input.searchMode && this.queryContextCache.topSitesContext) {
          this.onQueryResults(this.queryContextCache.topSitesContext);
        }
        this.input.startQuery(queryOptions);
        if (suppressFocusBorder) {
          this.input.toggleAttribute("suppress-focus-border", true);
        }
        return true;
      }
      return false;
    }

    // Reopen abandoned searches only if the input is focused.
    if (!this.input.focused) {
      return false;
    }

    // Tab switch is the only case where we requery if the view is open, because
    // switching tabs doesn't necessarily close the view.
    if (this.isOpen && event.type != "tabswitch") {
      return false;
    }

    if (
      this.#rows.firstElementChild &&
      this.#queryContext.searchString == this.input.value
    ) {
      // We can reuse the current results.
      queryOptions.allowAutofill = this.#queryContext.allowAutofill;
    } else {
      // To reduce results flickering, try to reuse a cached UrlbarQueryContext.
      let cachedQueryContext = this.queryContextCache.get(this.input.value);
      if (cachedQueryContext) {
        this.onQueryResults(cachedQueryContext);
      }
    }

    this.controller.engagementEvent.discard();
    queryOptions.searchString = this.input.value;
    queryOptions.autofillIgnoresSelection = true;
    queryOptions.event.interactionType = "returned";

    if (
      this.#queryContext &&
      this.#queryContext.results &&
      this.#queryContext.results.length
    ) {
      this.#openPanel();
    }

    // If we had cached results, this will just refresh them, avoiding results
    // flicker, otherwise there may be some noise.
    this.input.startQuery(queryOptions);
    if (suppressFocusBorder) {
      this.input.toggleAttribute("suppress-focus-border", true);
    }
    return true;
  }

  // UrlbarController listener methods.
  onQueryStarted(queryContext) {
    this.#queryWasCancelled = false;
    this.#queryUpdatedResults = false;
    this.#openPanelInstance = null;
    if (!queryContext.searchString) {
      this.#previousTabToSearchEngine = null;
    }
    this.#startRemoveStaleRowsTimer();

    // Cache l10n strings so they're available when we update the view as
    // results arrive. This is a no-op for strings that are already cached.
    // `#cacheL10nStrings` is async but we don't await it because doing so would
    // require view updates to be async. Instead we just opportunistically cache
    // and if there's a cache miss we fall back to `l10n.setAttributes`.
    this.#cacheL10nStrings();
  }

  onQueryCancelled(queryContext) {
    this.#queryWasCancelled = true;
    this.#cancelRemoveStaleRowsTimer();
  }

  onQueryFinished(queryContext) {
    this.#cancelRemoveStaleRowsTimer();
    if (this.#queryWasCancelled) {
      return;
    }

    // If the query finished and it returned some results, remove stale rows.
    if (this.#queryUpdatedResults) {
      this.#removeStaleRows();
      return;
    }

    // The query didn't return any results.  Clear the view.
    this.clear();

    // If search mode isn't active, close the view.
    if (!this.input.searchMode) {
      this.close();
      return;
    }

    // Search mode is active.  If the one-offs should be shown, make sure they
    // are enabled and show the view.
    let openPanelInstance = (this.#openPanelInstance = {});
    this.oneOffSearchButtons.willHide().then(willHide => {
      if (!willHide && openPanelInstance == this.#openPanelInstance) {
        this.oneOffSearchButtons.enable(true);
        this.#openPanel();
      }
    });
  }

  onQueryResults(queryContext) {
    this.queryContextCache.put(queryContext);
    this.#queryContext = queryContext;

    if (!this.isOpen) {
      this.clear();
    }
    this.#queryUpdatedResults = true;
    this.#updateResults();

    let firstResult = queryContext.results[0];

    if (queryContext.lastResultCount == 0) {
      // Clear the selection when we get a new set of results.
      this.#selectElement(null, {
        updateInput: false,
      });

      // Show the one-off search buttons unless any of the following are true:
      //  * The first result is a search tip
      //  * The search string is empty
      //  * The search string starts with an `@` or a search restriction
      //    character
      this.oneOffSearchButtons.enable(
        firstResult.providerName != "UrlbarProviderSearchTips" &&
          queryContext.trimmedSearchString[0] != "@" &&
          (queryContext.trimmedSearchString[0] !=
            lazy.UrlbarTokenizer.RESTRICT.SEARCH ||
            queryContext.trimmedSearchString.length != 1)
      );
    }

    if (!this.selectedElement && !this.oneOffSearchButtons.selectedButton) {
      if (firstResult.heuristic) {
        // Select the heuristic result.  The heuristic may not be the first
        // result added, which is why we do this check here when each result is
        // added and not above.
        if (this.#shouldShowHeuristic(firstResult)) {
          this.#selectElement(this.#getFirstSelectableElement(), {
            updateInput: false,
            setAccessibleFocus:
              this.controller._userSelectionBehavior == "arrow",
          });
        } else {
          this.input.setResultForCurrentValue(firstResult);
        }
      } else if (
        firstResult.payload.providesSearchMode &&
        queryContext.trimmedSearchString != "@"
      ) {
        // Filtered keyword offer results can be in the first position but not
        // be heuristic results. We do this so the user can press Tab to select
        // them, resembling tab-to-search. In that case, the input value is
        // still associated with the first result.
        this.input.setResultForCurrentValue(firstResult);
      }
    }

    // Announce tab-to-search results to screen readers as the user types.
    // Check to make sure we don't announce the same engine multiple times in
    // a row.
    let secondResult = queryContext.results[1];
    if (
      secondResult?.providerName == "TabToSearch" &&
      lazy.UrlbarPrefs.get("accessibility.tabToSearch.announceResults") &&
      this.#previousTabToSearchEngine != secondResult.payload.engine
    ) {
      let engine = secondResult.payload.engine;
      this.window.A11yUtils.announce({
        id: secondResult.payload.isGeneralPurposeEngine
          ? "urlbar-result-action-before-tabtosearch-web"
          : "urlbar-result-action-before-tabtosearch-other",
        args: { engine },
      });
      this.#previousTabToSearchEngine = engine;
      // Do not set aria-activedescendant when the user tabs to the result
      // because we already announced it.
      this.#announceTabToSearchOnSelection = false;
    }

    // If we update the selected element, a new unique ID is generated for it.
    // We need to ensure that aria-activedescendant reflects this new ID.
    if (this.selectedElement && !this.oneOffSearchButtons.selectedButton) {
      let aadID = this.input.inputField.getAttribute("aria-activedescendant");
      if (aadID && !this.document.getElementById(aadID)) {
        this.#setAccessibleFocus(this.selectedElement);
      }
    }

    this.#openPanel();

    if (firstResult.heuristic) {
      // The heuristic result may be a search alias result, so apply formatting
      // if necessary.  Conversely, the heuristic result of the previous query
      // may have been an alias, so remove formatting if necessary.
      this.input.formatValue();
    }

    if (queryContext.deferUserSelectionProviders.size) {
      // DeferUserSelectionProviders block user selection until the result is
      // shown, so it's the view's duty to remove them.
      // Doing it sooner, like when the results are added by the provider,
      // would not suffice because there's still a delay before those results
      // reach the view.
      queryContext.results.forEach(r => {
        queryContext.deferUserSelectionProviders.delete(r.providerName);
      });
    }
  }

  /**
   * Handles removing a result from the view when it is removed from the query,
   * and attempts to select the new result on the same row.
   *
   * This assumes that the result rows are in index order.
   *
   * @param {number} index The index of the result that has been removed.
   */
  onQueryResultRemoved(index) {
    let rowToRemove = this.#rows.children[index];
    rowToRemove.remove();

    this.#updateIndices();

    if (rowToRemove != this.#getSelectedRow()) {
      return;
    }

    // Select the row at the same index, if possible.
    let newSelectionIndex = index;
    if (index >= this.#queryContext.results.length) {
      newSelectionIndex = this.#queryContext.results.length - 1;
    }
    if (newSelectionIndex >= 0) {
      this.selectedRowIndex = newSelectionIndex;
    }
  }

  openResultMenu(result, anchor) {
    this.#resultMenuResult = result;
    this.#resultMenu.openPopup(anchor, "bottomright topright");
    anchor.toggleAttribute("open", true);
    this.#resultMenu.addEventListener(
      "popuphidden",
      () => {
        anchor.toggleAttribute("open", false);
        this.#resultMenuResult = null;
      },
      { once: true }
    );
  }

  /**
   * Passes DOM events for the view to the on_<event type> methods.
   *
   * @param {Event} event
   *   DOM event from the <view>.
   */
  handleEvent(event) {
    let methodName = "on_" + event.type;
    if (methodName in this) {
      this[methodName](event);
    } else {
      throw new Error("Unrecognized UrlbarView event: " + event.type);
    }
  }

  static dynamicViewTemplatesByName = new Map();

  /**
   * Registers the view template for a dynamic result type.  A view template is
   * a plain object that describes the DOM subtree for a dynamic result type.
   * When a dynamic result is shown in the urlbar view, its type's view template
   * is used to construct the part of the view that represents the result.
   *
   * The specified view template will be available to the urlbars in all current
   * and future browser windows until it is unregistered.  A given dynamic
   * result type has at most one view template.  If this method is called for a
   * dynamic result type more than once, the view template in the last call
   * overrides those in previous calls.
   *
   * @param {string} name
   *   The view template will be registered for the dynamic result type with
   *   this name.
   * @param {object} viewTemplate
   *   This object describes the DOM subtree for the given dynamic result type.
   *   It should be a tree-like nested structure with each object in the nesting
   *   representing a DOM element to be created.  This tree-like structure is
   *   achieved using the `children` property described below.  Each object in
   *   the structure may include the following properties:
   *
   *   {string} name
   *     The name of the object.  It is required for all objects in the
   *     structure except the root object and serves two important functions:
   *     (1) The element created for the object will automatically have a class
   *         named `urlbarView-dynamic-${dynamicType}-${name}`, where
   *         `dynamicType` is the name of the dynamic result type.  The element
   *         will also automatically have an attribute "name" whose value is
   *         this name.  The class and attribute allow the element to be styled
   *         in CSS.
   *     (2) The name is used when updating the view.  See
   *         UrlbarProvider.getViewUpdate().
   *     Names must be unique within a view template, but they don't need to be
   *     globally unique.  i.e., two different view templates can use the same
   *     names, and other DOM elements can use the same names in their IDs and
   *     classes.  The name also suffixes the dynamic element's ID: an element
   *     with name `data` will get the ID `urlbarView-row-{unique number}-data`.
   *     If there is no name provided for the root element, the root element
   *     will not get an ID.
   *   {string} tag
   *     The tag name of the object.  It is required for all objects in the
   *     structure except the root object and declares the kind of element that
   *     will be created for the object: span, div, img, etc.
   *   {object} [attributes]
   *     An optional mapping from attribute names to values.  For each
   *     name-value pair, an attribute is added to the element created for the
   *     object. The `id` attribute is reserved and cannot be set by the
   *     provider. Element IDs are passed back to the provider in getViewUpdate
   *     if they are needed.
   *   {array} [children]
   *     An optional list of children.  Each item in the array must be an object
   *     as described here.  For each item, a child element as described by the
   *     item is created and added to the element created for the parent object.
   *   {array} [classList]
   *     An optional list of classes.  Each class will be added to the element
   *     created for the object by calling element.classList.add().
   *   {string} [stylesheet]
   *     An optional stylesheet URL.  This property is valid only on the root
   *     object in the structure.  The stylesheet will be loaded in all browser
   *     windows so that the dynamic result type view may be styled.
   */
  static addDynamicViewTemplate(name, viewTemplate) {
    this.dynamicViewTemplatesByName.set(name, viewTemplate);
    if (viewTemplate.stylesheet) {
      for (let window of lazy.BrowserWindowTracker.orderedWindows) {
        addDynamicStylesheet(window, viewTemplate.stylesheet);
      }
    }
  }

  /**
   * Unregisters the view template for a dynamic result type.
   *
   * @param {string} name
   *   The view template will be unregistered for the dynamic result type with
   *   this name.
   */
  static removeDynamicViewTemplate(name) {
    let viewTemplate = this.dynamicViewTemplatesByName.get(name);
    if (!viewTemplate) {
      return;
    }
    this.dynamicViewTemplatesByName.delete(name);
    if (viewTemplate.stylesheet) {
      for (let window of lazy.BrowserWindowTracker.orderedWindows) {
        removeDynamicStylesheet(window, viewTemplate.stylesheet);
      }
    }
  }

  // Private properties and methods below.
  #announceTabToSearchOnSelection;
  #l10nCache;
  #mainContainer;
  #openPanelInstance;
  #oneOffSearchButtons;
  #previousTabToSearchEngine;
  #queryContext;
  #queryUpdatedResults;
  #queryWasCancelled;
  #removeStaleRowsTimer;
  #resultMenu;
  #resultMenuResult;
  #rows;
  #selectedElement;

  #createElement(name) {
    return this.document.createElementNS("http://www.w3.org/1999/xhtml", name);
  }

  #openPanel() {
    if (this.isOpen) {
      return;
    }
    this.controller.userSelectionBehavior = "none";

    this.panel.removeAttribute("actionoverride");

    this.#enableOrDisableRowWrap();

    this.input.inputField.setAttribute("aria-expanded", "true");

    this.input.toggleAttribute("suppress-focus-border", true);
    this.input.setAttribute("open", "true");
    this.input.startLayoutExtend();

    this.window.addEventListener("resize", this);
    this.window.addEventListener("blur", this);

    this.controller.notify(this.controller.NOTIFICATIONS.VIEW_OPEN);
  }

  #shouldShowHeuristic(result) {
    if (!result?.heuristic) {
      throw new Error("A heuristic result must be given");
    }
    return (
      !lazy.UrlbarPrefs.get("experimental.hideHeuristic") ||
      result.type == lazy.UrlbarUtils.RESULT_TYPE.TIP
    );
  }

  /**
   * Whether a result is a search suggestion.
   *
   * @param {UrlbarResult} result The result to examine.
   * @returns {boolean} Whether the result is a search suggestion.
   */
  #resultIsSearchSuggestion(result) {
    return Boolean(
      result &&
        result.type == lazy.UrlbarUtils.RESULT_TYPE.SEARCH &&
        result.payload.suggestion
    );
  }

  /**
   * Checks whether the given row index can be update to the result we want
   * to apply. This is used in #updateResults to avoid flickering of results, by
   * reusing existing rows.
   *
   * @param {number} rowIndex Index of the row to examine.
   * @param {UrlbarResult} result The result we'd like to apply.
   * @param {boolean} seenSearchSuggestion Whether the view update has
   *        encountered an existing row with a search suggestion result.
   * @returns {boolean} Whether the row can be updated to this result.
   */
  #rowCanUpdateToResult(rowIndex, result, seenSearchSuggestion) {
    // The heuristic result must always be current, thus it's always compatible.
    if (result.heuristic) {
      return true;
    }
    let row = this.#rows.children[rowIndex];
    if (result.hasSuggestedIndex != row.result.hasSuggestedIndex) {
      // Don't replace a suggestedIndex result with a non-suggestedIndex result
      // or vice versa.
      return false;
    }
    if (
      result.hasSuggestedIndex &&
      result.suggestedIndex != row.result.suggestedIndex
    ) {
      // Don't replace a suggestedIndex result with another suggestedIndex
      // result if the suggestedIndex values are different.
      return false;
    }
    let resultIsSearchSuggestion = this.#resultIsSearchSuggestion(result);
    // If the row is same type, just update it.
    if (
      resultIsSearchSuggestion == this.#resultIsSearchSuggestion(row.result)
    ) {
      return true;
    }
    // If the row has a different type, update it if we are in a compatible
    // index range.
    // In practice we don't want to overwrite a search suggestion with a non
    // search suggestion, but we allow the opposite.
    return resultIsSearchSuggestion && seenSearchSuggestion;
  }

  #updateResults() {
    // TODO: For now this just compares search suggestions to the rest, in the
    // future we should make it support any type of result. Or, even better,
    // results should be grouped, thus we can directly update groups.

    // Walk rows and find an insertion index for results. To avoid flicker, we
    // skip rows until we find one compatible with the result we want to apply.
    // If we couldn't find a compatible range, we'll just update.
    let results = this.#queryContext.results;
    if (results[0]?.heuristic && !this.#shouldShowHeuristic(results[0])) {
      // Exclude the heuristic.
      results = results.slice(1);
    }
    let rowIndex = 0;
    let resultIndex = 0;
    let visibleSpanCount = 0;
    let seenMisplacedResult = false;
    let seenSearchSuggestion = false;

    // We can have more rows than the visible ones.
    for (
      ;
      rowIndex < this.#rows.children.length && resultIndex < results.length;
      ++rowIndex
    ) {
      let row = this.#rows.children[rowIndex];
      if (this.#isElementVisible(row)) {
        visibleSpanCount += lazy.UrlbarUtils.getSpanForResult(row.result);
      }
      // Continue updating rows as long as we haven't encountered a new
      // suggestedIndex result that couldn't replace a current result.
      if (!seenMisplacedResult) {
        seenSearchSuggestion =
          seenSearchSuggestion ||
          (!row.result.heuristic && this.#resultIsSearchSuggestion(row.result));
        let result = results[resultIndex];
        if (
          this.#rowCanUpdateToResult(rowIndex, result, seenSearchSuggestion)
        ) {
          // We can replace the row's current result with the new one.
          this.#updateRow(row, result);
          resultIndex++;
          continue;
        }
        if (result.hasSuggestedIndex || row.result.hasSuggestedIndex) {
          seenMisplacedResult = true;
        }
      }
      row.setAttribute("stale", "true");
    }

    // Mark all the remaining rows as stale and update the visible span count.
    // We include stale rows in the count because we should never show more than
    // maxResults spans at one time.  Later we'll remove stale rows and unhide
    // excess non-stale rows.
    for (; rowIndex < this.#rows.children.length; ++rowIndex) {
      let row = this.#rows.children[rowIndex];
      row.setAttribute("stale", "true");
      if (this.#isElementVisible(row)) {
        visibleSpanCount += lazy.UrlbarUtils.getSpanForResult(row.result);
      }
    }

    // Add remaining results, if we have fewer rows than results.
    for (; resultIndex < results.length; ++resultIndex) {
      let row = this.#createRow();
      let result = results[resultIndex];
      this.#updateRow(row, result);
      if (!seenMisplacedResult && result.hasSuggestedIndex) {
        if (result.isSuggestedIndexRelativeToGroup) {
          // We can't know at this point what the right index of a group-
          // relative suggestedIndex result will be. To avoid all all possible
          // flicker, don't make it (and all rows after it) visible until stale
          // rows are removed.
          seenMisplacedResult = true;
        } else {
          // We need to check whether the new suggestedIndex result will end up
          // at its right index if we append it here. The "right" index is the
          // final index the result will occupy once the update is done and all
          // stale rows have been removed. We could use a more flexible
          // definition, but we use this strict one in order to avoid all
          // perceived flicker and movement of suggestedIndex results. Once
          // stale rows are removed, the final number of rows in the view will
          // be the new result count, so we base our arithmetic here on it.
          let finalIndex =
            result.suggestedIndex >= 0
              ? Math.min(results.length - 1, result.suggestedIndex)
              : Math.max(0, results.length + result.suggestedIndex);
          if (this.#rows.children.length != finalIndex) {
            seenMisplacedResult = true;
          }
        }
      }
      let newVisibleSpanCount =
        visibleSpanCount + lazy.UrlbarUtils.getSpanForResult(result);
      if (
        newVisibleSpanCount <= this.#queryContext.maxResults &&
        !seenMisplacedResult
      ) {
        // The new row can be visible.
        visibleSpanCount = newVisibleSpanCount;
      } else {
        // The new row must be hidden at first because the view is already
        // showing maxResults spans, or we encountered a new suggestedIndex
        // result that couldn't be placed in the right spot. We'll show it when
        // stale rows are removed.
        this.#setRowVisibility(row, false);
      }
      this.#rows.appendChild(row);
    }

    this.#updateIndices();
  }

  #createRow() {
    let item = this.#createElement("div");
    item.className = "urlbarView-row";
    item.setAttribute("role", "option");
    item._elements = new Map();
    item._buttons = new Map();
    return item;
  }

  #createRowContent(item, result) {
    // The url is the only element that can wrap, thus all the other elements
    // are child of noWrap.
    let noWrap = this.#createElement("span");
    noWrap.className = "urlbarView-no-wrap";
    item._content.appendChild(noWrap);

    let favicon = this.#createElement("img");
    favicon.className = "urlbarView-favicon";
    noWrap.appendChild(favicon);
    item._elements.set("favicon", favicon);

    let typeIcon = this.#createElement("span");
    typeIcon.className = "urlbarView-type-icon";
    noWrap.appendChild(typeIcon);

    let tailPrefix = this.#createElement("span");
    tailPrefix.className = "urlbarView-tail-prefix";
    noWrap.appendChild(tailPrefix);
    item._elements.set("tailPrefix", tailPrefix);
    // tailPrefix holds text only for alignment purposes so it should never be
    // read to screen readers.
    tailPrefix.toggleAttribute("aria-hidden", true);

    let tailPrefixStr = this.#createElement("span");
    tailPrefixStr.className = "urlbarView-tail-prefix-string";
    tailPrefix.appendChild(tailPrefixStr);
    item._elements.set("tailPrefixStr", tailPrefixStr);

    let tailPrefixChar = this.#createElement("span");
    tailPrefixChar.className = "urlbarView-tail-prefix-char";
    tailPrefix.appendChild(tailPrefixChar);
    item._elements.set("tailPrefixChar", tailPrefixChar);

    let title = this.#createElement("span");
    title.className = "urlbarView-title";
    noWrap.appendChild(title);
    item._elements.set("title", title);

    let tagsContainer = this.#createElement("span");
    tagsContainer.className = "urlbarView-tags";
    noWrap.appendChild(tagsContainer);
    item._elements.set("tagsContainer", tagsContainer);

    let titleSeparator = this.#createElement("span");
    titleSeparator.className = "urlbarView-title-separator";
    noWrap.appendChild(titleSeparator);
    item._elements.set("titleSeparator", titleSeparator);

    let action = this.#createElement("span");
    action.className = "urlbarView-action";
    noWrap.appendChild(action);
    item._elements.set("action", action);

    let url = this.#createElement("span");
    url.className = "urlbarView-url";
    item._content.appendChild(url);
    item._elements.set("url", url);

    // Usually we create all child elements for the row regardless of whether
    // the specific result will use them, but we don't expect the vast majority
    // of rows to need help or block buttons, so as an optimization, create them
    // only when necessary.
    if (
      result.providerName == "UrlbarProviderQuickSuggest" &&
      lazy.UrlbarPrefs.get("quickSuggestBlockingEnabled")
    ) {
      this.#addRowButton(item, "block", "firefox-suggest-urlbar-block");
    }
    if (result.payload.helpUrl) {
      this.#addRowButton(item, "help", result.payload.helpL10nId);
    }
    if (lazy.UrlbarPrefs.get("resultMenu")) {
      this.#addRowButton(item, "menu", "urlbar-result-menu-button");
    }
  }

  #createRowContentForTip(item) {
    // We use role="group" so screen readers will read the group's label when a
    // button inside it gets focus. (Screen readers don't do this for
    // role="option".) We set aria-labelledby for the group in #updateRowForTip.
    item._content.setAttribute("role", "group");

    let favicon = this.#createElement("img");
    favicon.className = "urlbarView-favicon";
    favicon.setAttribute("data-l10n-id", "urlbar-tip-icon-description");
    item._content.appendChild(favicon);
    item._elements.set("favicon", favicon);

    let title = this.#createElement("span");
    title.className = "urlbarView-title";
    item._content.appendChild(title);
    item._elements.set("title", title);

    let buttonSpacer = this.#createElement("span");
    buttonSpacer.className = "urlbarView-tip-button-spacer";
    item._content.appendChild(buttonSpacer);

    let tipButton = this.#createElement("span");
    tipButton.className = "urlbarView-tip-button";
    tipButton.setAttribute("role", "button");
    item._content.appendChild(tipButton);
    item._elements.set("tipButton", tipButton);

    let helpIcon = this.#createElement("span");
    helpIcon.classList.add("urlbarView-button", "urlbarView-button-help");
    helpIcon.setAttribute("role", "button");
    helpIcon.setAttribute("data-l10n-id", "urlbar-tip-help-icon");
    item._elements.set("helpButton", helpIcon);
    item._content.appendChild(helpIcon);

    // Due to role=button, the button and help icon can sometimes become
    // focused.  We want to prevent that because the input should always be
    // focused instead.  (This happens when input.search("", { focus: false })
    // is called, a tip is the first result but not heuristic, and the user tabs
    // the into the button from the navbar buttons.  The input is skipped and
    // the focus goes straight to the tip button.)
    item.addEventListener("focus", () => this.input.focus(), true);
  }

  #createRowContentForDynamicType(item, result) {
    let { dynamicType } = result.payload;
    let provider = lazy.UrlbarProvidersManager.getProvider(result.providerName);
    let viewTemplate =
      provider.getViewTemplate?.(result) ||
      UrlbarView.dynamicViewTemplatesByName.get(dynamicType);
    if (!viewTemplate) {
      Cu.reportError(`No viewTemplate found for ${result.providerName}`);
    }
    this.#buildViewForDynamicType(
      dynamicType,
      item._content,
      item._elements,
      viewTemplate
    );
  }

  #buildViewForDynamicType(type, parentNode, elementsByName, template) {
    // Add classes to parentNode's classList.
    for (let className of template.classList || []) {
      parentNode.classList.add(className);
    }
    // Set attributes on parentNode.
    for (let [name, value] of Object.entries(template.attributes || {})) {
      if (name == "id") {
        // We do not allow dynamic results to set IDs for their Nodes. IDs are
        // managed by the view to ensure they are unique.
        Cu.reportError(
          "Dynamic results are prohibited from setting their own IDs."
        );
        continue;
      }
      parentNode.setAttribute(name, value);
    }
    if (template.name) {
      parentNode.setAttribute("name", template.name);
      elementsByName.set(template.name, parentNode);
    }
    // Recurse into children.
    for (let childTemplate of template.children || []) {
      let child = this.#createElement(childTemplate.tag);
      child.classList.add(`urlbarView-dynamic-${type}-${childTemplate.name}`);
      parentNode.appendChild(child);
      this.#buildViewForDynamicType(type, child, elementsByName, childTemplate);
    }
  }

  #createRowContentForBestMatch(item, result) {
    let favicon = this.#createElement("img");
    favicon.className = "urlbarView-favicon";
    item._content.appendChild(favicon);
    item._elements.set("favicon", favicon);

    let typeIcon = this.#createElement("span");
    typeIcon.className = "urlbarView-type-icon";
    item._content.appendChild(typeIcon);

    let body = this.#createElement("span");
    body.className = "urlbarView-row-body";
    item._content.appendChild(body);

    let top = this.#createElement("div");
    top.className = "urlbarView-row-body-top";
    body.appendChild(top);

    let noWrap = this.#createElement("div");
    noWrap.className = "urlbarView-row-body-top-no-wrap";
    top.appendChild(noWrap);
    item._elements.set("noWrap", noWrap);

    let title = this.#createElement("span");
    title.className = "urlbarView-title";
    noWrap.appendChild(title);
    item._elements.set("title", title);

    let titleSeparator = this.#createElement("span");
    titleSeparator.className = "urlbarView-title-separator";
    noWrap.appendChild(titleSeparator);
    item._elements.set("titleSeparator", titleSeparator);

    let url = this.#createElement("span");
    url.className = "urlbarView-url";
    top.appendChild(url);
    item._elements.set("url", url);

    let bottom = this.#createElement("div");
    bottom.className = "urlbarView-row-body-bottom";
    body.appendChild(bottom);
    item._elements.set("bottom", bottom);

    if (lazy.UrlbarPrefs.get("bestMatchBlockingEnabled")) {
      this.#addRowButton(item, "block", "firefox-suggest-urlbar-block");
    }
    if (result.payload.helpUrl) {
      this.#addRowButton(item, "help", result.payload.helpL10nId);
    }
  }

  #addRowButton(item, name, l10nID) {
    if (!item._buttons.size) {
      // If the content is marked as selectable, the screen reader will not be
      // able to read the text directly child of the "urlbarView-row". As the
      // group label is shown as pseudo element of urlbarView-row now, it isn't
      // readable. To avoid it, we add an element for aria-label explictly,
      // and set group label that should be read into it in #updateIndices().
      const groupAriaLabel = this.#createElement("span");
      groupAriaLabel.className = "urlbarView-group-aria-label";
      item._content.insertBefore(groupAriaLabel, item._content.firstChild);
      item._elements.set("groupAriaLabel", groupAriaLabel);

      item._content.setAttribute("role", "option");
      item._content.setAttribute("selectable", "true");
    }

    let button = this.#createElement("span");
    button.classList.add("urlbarView-button", "urlbarView-button-" + name);
    button.setAttribute("role", "button");
    if (l10nID) {
      button.setAttribute("data-l10n-id", l10nID);
    }
    item._buttons.set(name, button);
    item.appendChild(button);
  }

  // eslint-disable-next-line complexity
  #updateRow(item, result) {
    let oldResult = item.result;
    let oldResultType = item.result && item.result.type;
    let provider = lazy.UrlbarProvidersManager.getProvider(result.providerName);
    item.result = result;
    item.removeAttribute("stale");
    item.id = getUniqueId("urlbarView-row-");

    let needsNewContent =
      oldResultType === undefined ||
      (oldResultType == lazy.UrlbarUtils.RESULT_TYPE.TIP) !=
        (result.type == lazy.UrlbarUtils.RESULT_TYPE.TIP) ||
      (oldResultType == lazy.UrlbarUtils.RESULT_TYPE.DYNAMIC) !=
        (result.type == lazy.UrlbarUtils.RESULT_TYPE.DYNAMIC) ||
      (oldResultType == lazy.UrlbarUtils.RESULT_TYPE.DYNAMIC &&
        result.type == lazy.UrlbarUtils.RESULT_TYPE.DYNAMIC &&
        oldResult.payload.dynamicType != result.payload.dynamicType) ||
      // Dynamic results that implement getViewTemplate will
      // always need updating.
      provider.getViewTemplate ||
      oldResult.isBestMatch != result.isBestMatch ||
      !!result.payload.helpUrl != item._buttons.has("help") ||
      (result.isBestMatch &&
        lazy.UrlbarPrefs.get("bestMatchBlockingEnabled") !=
          item._buttons.has("block")) ||
      (!result.isBestMatch &&
        result.providerName == "UrlbarProviderQuickSuggest" &&
        lazy.UrlbarPrefs.get("quickSuggestBlockingEnabled") !=
          item._buttons.has("block"));

    if (needsNewContent) {
      while (item.lastChild) {
        item.lastChild.remove();
      }
      item._elements.clear();
      item._buttons.clear();
      item._content = this.#createElement("span");
      item._content.className = "urlbarView-row-inner";
      item.appendChild(item._content);
      item.removeAttribute("dynamicType");
      if (item.result.type == lazy.UrlbarUtils.RESULT_TYPE.TIP) {
        this.#createRowContentForTip(item);
      } else if (item.result.type == lazy.UrlbarUtils.RESULT_TYPE.DYNAMIC) {
        this.#createRowContentForDynamicType(item, result);
      } else if (item.result.isBestMatch) {
        this.#createRowContentForBestMatch(item, result);
      } else {
        this.#createRowContent(item, result);
      }
    }
    item._content.id = item.id + "-inner";

    if (
      result.type == lazy.UrlbarUtils.RESULT_TYPE.SEARCH &&
      !result.payload.providesSearchMode &&
      !result.payload.inPrivateWindow
    ) {
      item.setAttribute("type", "search");
    } else if (result.type == lazy.UrlbarUtils.RESULT_TYPE.REMOTE_TAB) {
      item.setAttribute("type", "remotetab");
    } else if (result.type == lazy.UrlbarUtils.RESULT_TYPE.TAB_SWITCH) {
      item.setAttribute("type", "switchtab");
    } else if (result.type == lazy.UrlbarUtils.RESULT_TYPE.TIP) {
      item.setAttribute("type", "tip");
      this.#updateRowForTip(item, result);
      return;
    } else if (result.source == lazy.UrlbarUtils.RESULT_SOURCE.BOOKMARKS) {
      item.setAttribute("type", "bookmark");
    } else if (result.type == lazy.UrlbarUtils.RESULT_TYPE.DYNAMIC) {
      item.setAttribute("type", "dynamic");
      this.#updateRowForDynamicType(item, result);
      return;
    } else if (result.providerName == "TabToSearch") {
      item.setAttribute("type", "tabtosearch");
    } else if (result.isBestMatch) {
      item.setAttribute("type", "bestmatch");
      this.#updateRowForBestMatch(item, result);
      return;
    } else {
      item.removeAttribute("type");
    }

    let favicon = item._elements.get("favicon");
    if (
      result.type == lazy.UrlbarUtils.RESULT_TYPE.SEARCH ||
      result.type == lazy.UrlbarUtils.RESULT_TYPE.KEYWORD
    ) {
      favicon.src = this.#iconForResult(result);
    } else {
      favicon.src = result.payload.icon || lazy.UrlbarUtils.ICON.DEFAULT;
    }

    let title = item._elements.get("title");
    this.#setResultTitle(result, title);

    if (result.payload.tail && result.payload.tailOffsetIndex > 0) {
      this.#fillTailSuggestionPrefix(item, result);
      title.setAttribute("aria-label", result.payload.suggestion);
      item.toggleAttribute("tail-suggestion", true);
    } else {
      item.removeAttribute("tail-suggestion");
      title.removeAttribute("aria-label");
    }

    title._tooltip = result.title;
    if (title.hasAttribute("overflow")) {
      title.setAttribute("title", title._tooltip);
    }

    let tagsContainer = item._elements.get("tagsContainer");
    tagsContainer.textContent = "";
    if (result.payload.tags && result.payload.tags.length) {
      tagsContainer.append(
        ...result.payload.tags.map((tag, i) => {
          const element = this.#createElement("span");
          element.className = "urlbarView-tag";
          this.#addTextContentWithHighlights(
            element,
            tag,
            result.payloadHighlights.tags[i]
          );
          return element;
        })
      );
    }

    let action = item._elements.get("action");
    let actionSetter = null;
    let isVisitAction = false;
    let setURL = false;
    switch (result.type) {
      case lazy.UrlbarUtils.RESULT_TYPE.TAB_SWITCH:
        actionSetter = () => {
          this.#setElementL10n(action, {
            id: "urlbar-result-action-switch-tab",
          });
        };
        setURL = true;
        break;
      case lazy.UrlbarUtils.RESULT_TYPE.REMOTE_TAB:
        actionSetter = () => {
          this.#removeElementL10n(action);
          action.textContent = result.payload.device;
        };
        setURL = true;
        break;
      case lazy.UrlbarUtils.RESULT_TYPE.SEARCH:
        if (result.payload.inPrivateWindow) {
          if (result.payload.isPrivateEngine) {
            actionSetter = () => {
              this.#setElementL10n(action, {
                id: "urlbar-result-action-search-in-private-w-engine",
                args: { engine: result.payload.engine },
              });
            };
          } else {
            actionSetter = () => {
              this.#setElementL10n(action, {
                id: "urlbar-result-action-search-in-private",
              });
            };
          }
        } else if (result.providerName == "TabToSearch") {
          actionSetter = () => {
            this.#setElementL10n(action, {
              id: result.payload.isGeneralPurposeEngine
                ? "urlbar-result-action-tabtosearch-web"
                : "urlbar-result-action-tabtosearch-other-engine",
              args: { engine: result.payload.engine },
            });
          };
        } else if (!result.payload.providesSearchMode) {
          actionSetter = () => {
            this.#setElementL10n(action, {
              id: "urlbar-result-action-search-w-engine",
              args: { engine: result.payload.engine },
            });
          };
        }
        break;
      case lazy.UrlbarUtils.RESULT_TYPE.KEYWORD:
        isVisitAction = result.payload.input.trim() == result.payload.keyword;
        break;
      case lazy.UrlbarUtils.RESULT_TYPE.OMNIBOX:
        actionSetter = () => {
          this.#removeElementL10n(action);
          action.textContent = result.payload.content;
        };
        break;
      default:
        if (result.heuristic && !result.autofill?.hasTitle) {
          isVisitAction = true;
        } else if (result.providerName != "UrlbarProviderQuickSuggest") {
          setURL = true;
        }
        break;
    }

    if (result.providerName == "TabToSearch") {
      action.toggleAttribute("slide-in", true);
    } else {
      action.removeAttribute("slide-in");
    }

    if (result.payload.isPinned) {
      item.toggleAttribute("pinned", true);
    } else {
      item.removeAttribute("pinned");
    }

    if (
      result.payload.isSponsored &&
      result.type != lazy.UrlbarUtils.RESULT_TYPE.TAB_SWITCH
    ) {
      item.toggleAttribute("sponsored", true);
      actionSetter = () => {
        this.#setElementL10n(action, {
          id: "urlbar-result-action-sponsored",
        });
      };
    } else {
      item.removeAttribute("sponsored");
    }

    if (
      result.providerName == "UrlbarProviderQuickSuggest" &&
      result.payload.isSponsored
    ) {
      item.toggleAttribute("firefox-suggest-sponsored", true);
    } else {
      item.removeAttribute("firefox-suggest-sponsored");
    }

    let url = item._elements.get("url");
    if (setURL) {
      item.setAttribute("has-url", "true");
      this.#addTextContentWithHighlights(
        url,
        result.payload.displayUrl,
        result.payloadHighlights.displayUrl || []
      );
      url._tooltip = result.payload.displayUrl;
    } else {
      item.removeAttribute("has-url");
      url.textContent = "";
      url._tooltip = "";
    }
    if (url.hasAttribute("overflow")) {
      url.setAttribute("title", url._tooltip);
    }

    if (isVisitAction) {
      actionSetter = () => {
        this.#setElementL10n(action, {
          id: "urlbar-result-action-visit",
        });
      };
      title.setAttribute("isurl", "true");
    } else {
      title.removeAttribute("isurl");
    }

    if (actionSetter) {
      actionSetter();
      item._originalActionSetter = actionSetter;
      item.setAttribute("has-action", "true");
    } else {
      item._originalActionSetter = () => {
        this.#removeElementL10n(action);
        action.textContent = "";
      };
      item._originalActionSetter();
      item.removeAttribute("has-action");
    }

    if (!title.hasAttribute("isurl")) {
      title.setAttribute("dir", "auto");
    } else {
      title.removeAttribute("dir");
    }

    this.#updateRowForButtons(item);
  }

  #iconForResult(result, iconUrlOverride = null) {
    return (
      (result.source == lazy.UrlbarUtils.RESULT_SOURCE.HISTORY &&
        (result.type == lazy.UrlbarUtils.RESULT_TYPE.SEARCH ||
          result.type == lazy.UrlbarUtils.RESULT_TYPE.KEYWORD) &&
        lazy.UrlbarUtils.ICON.HISTORY) ||
      iconUrlOverride ||
      result.payload.icon ||
      ((result.type == lazy.UrlbarUtils.RESULT_TYPE.SEARCH ||
        result.type == lazy.UrlbarUtils.RESULT_TYPE.KEYWORD) &&
        lazy.UrlbarUtils.ICON.SEARCH_GLASS) ||
      lazy.UrlbarUtils.ICON.DEFAULT
    );
  }

  #updateRowForTip(item, result) {
    let favicon = item._elements.get("favicon");
    favicon.src = result.payload.icon || lazy.UrlbarUtils.ICON.TIP;
    favicon.id = item.id + "-icon";

    let title = item._elements.get("title");
    title.id = item.id + "-title";
    // Add-ons will provide text, rather than l10n ids.
    if (result.payload.textData) {
      this.#l10nCache.ensureAll([result.payload.textData]);
      this.#setElementL10n(title, result.payload.textData);
    } else {
      title.textContent = result.payload.text;
    }

    item._content.setAttribute("aria-labelledby", `${favicon.id} ${title.id}`);

    let tipButton = item._elements.get("tipButton");
    tipButton.id = item.id + "-tip-button";
    // Add-ons will provide buttonText, rather than l10n ids.
    if (result.payload.buttonTextData) {
      this.#l10nCache.ensureAll([result.payload.buttonTextData]);
      this.#setElementL10n(tipButton, result.payload.buttonTextData);
    } else {
      tipButton.textContent = result.payload.buttonText;
    }

    let helpIcon = item._elements.get("helpButton");
    helpIcon.id = item.id + "-tip-help";
    helpIcon.style.display = result.payload.helpUrl ? "" : "none";

    if (result.providerName == "UrlbarProviderSearchTips") {
      // For a11y, we treat search tips as alerts.  We use A11yUtils.announce
      // instead of role="alert" because role="alert" will only fire an alert
      // event when the alert (or something inside it) is the root of an
      // insertion.  In this case, the entire tip result gets inserted into the
      // a11y tree as a single insertion, so no alert event would be fired.
      this.window.A11yUtils.announce(result.payload.textData);
    }
  }

  async #updateRowForDynamicType(item, result) {
    item.setAttribute("dynamicType", result.payload.dynamicType);

    let idsByName = new Map();
    for (let [name, node] of item._elements) {
      node.id = `${item.id}-${name}`;
      idsByName.set(name, node.id);
    }

    // First, apply highlighting. We do this before updating via getViewUpdate
    // so the dynamic provider can override the highlighting by setting the
    // textContent of the highlighted node, if it wishes.
    for (let [payloadName, highlights] of Object.entries(
      result.payloadHighlights
    )) {
      if (!highlights.length) {
        continue;
      }
      // Highlighting only works if the dynamic element name is the same as the
      // highlighted payload property name.
      let nodeToHighlight = item.querySelector(`#${item.id}-${payloadName}`);
      this.#addTextContentWithHighlights(
        nodeToHighlight,
        result.payload[payloadName],
        highlights
      );
    }

    // Get the view update from the result's provider.
    let provider = lazy.UrlbarProvidersManager.getProvider(result.providerName);
    let viewUpdate = await provider.getViewUpdate(result, idsByName);

    // Update each node in the view by name.
    for (let [nodeName, update] of Object.entries(viewUpdate)) {
      let node = item.querySelector(`#${item.id}-${nodeName}`);
      for (let [attrName, value] of Object.entries(update.attributes || {})) {
        if (attrName == "id") {
          // We do not allow dynamic results to set IDs for their Nodes. IDs are
          // managed by the view to ensure they are unique.
          Cu.reportError(
            "Dynamic results are prohibited from setting their own IDs."
          );
          continue;
        }
        if (value === null) {
          node.removeAttribute(attrName);
        } else {
          node.setAttribute(attrName, value);
        }
      }
      for (let [styleName, value] of Object.entries(update.style || {})) {
        node.style[styleName] = value;
      }
      if (update.l10n) {
        if (update.l10n.cacheable) {
          await this.#l10nCache.ensureAll([update.l10n]);
        }
        this.#setElementL10n(node, {
          id: update.l10n.id,
          args: update.l10n.args || undefined,
        });
      } else if (update.textContent) {
        node.textContent = update.textContent;
      }
    }
  }

  #updateRowForBestMatch(item, result) {
    let favicon = item._elements.get("favicon");
    favicon.src = this.#iconForResult(result);

    let title = item._elements.get("title");
    this.#setResultTitle(result, title);
    title._tooltip = result.title;
    if (title.hasAttribute("overflow")) {
      title.setAttribute("title", title._tooltip);
    } else {
      title.removeAttribute("title");
    }

    let url = item._elements.get("url");
    this.#addTextContentWithHighlights(
      url,
      result.payload.displayUrl,
      result.payloadHighlights.displayUrl || []
    );
    url._tooltip = result.payload.displayUrl;
    if (url.hasAttribute("overflow")) {
      url.setAttribute("title", url._tooltip);
    } else {
      url.removeAttribute("title");
    }

    let bottom = item._elements.get("bottom");
    if (result.payload.isSponsored) {
      this.#setElementL10n(bottom, { id: "urlbar-result-action-sponsored" });
    } else {
      this.#removeElementL10n(bottom);
    }

    this.#updateRowForButtons(item);
  }

  #updateRowForButtons(item) {
    if (item._buttons.size) {
      item.setAttribute("has-buttons", "true");
      item.style.setProperty("--button-count", item._buttons.size);
      for (let [name, button] of item._buttons) {
        button.id = `${item.id}-button-${name}`;
      }

      // When the row has buttons we set role=option on row-inner since the
      // latter is the selectable logical row element when buttons are present.
      // Since row-inner is not a child of the role=listbox element (the row
      // container, this.#rows), screen readers will not automatically recognize
      // it as a listbox option. To compensate, set role=presentation on the row
      // so that screen readers ignore it.
      item.setAttribute("role", "presentation");
    } else {
      item.removeAttribute("has-buttons");
      item.style.removeProperty("--button-count");
      item.setAttribute("role", "option");
    }
  }

  /**
   * Performs a final pass over all rows in the view after a view update, stale
   * rows are removed, and other changes to the number of rows. Sets `rowIndex`
   * on each result, updates row labels, and performs other tasks that must be
   * deferred until all rows have been updated.
   */
  #updateIndices() {
    this.visibleResults = [];

    // `currentLabel` is the last-seen row label as we iterate through the rows.
    // When we encounter a label that's different from `currentLabel`, we add it
    // to the row and set it to `currentLabel`; we remove the labels for all
    // other rows, and therefore no label will appear adjacent to itself. (A
    // label may appear more than once, but there will be at least one different
    // label in between.) Each row's label is determined by `#rowLabel()`.
    let currentLabel;

    let visibleRowsExist = false;
    for (let i = 0; i < this.#rows.children.length; i++) {
      let item = this.#rows.children[i];
      item.result.rowIndex = i;

      let visible = this.#isElementVisible(item);
      visibleRowsExist = visibleRowsExist || visible;

      let label;
      if (visible) {
        this.visibleResults.push(item.result);
        label = this.#rowLabel(item, currentLabel);
        if (label) {
          if (lazy.ObjectUtils.deepEqual(label, currentLabel)) {
            label = null;
          } else {
            currentLabel = label;
          }
        }
      }

      const groupAriaLabel = item._elements.get("groupAriaLabel");

      if (label) {
        this.#setElementL10n(item, {
          attribute: "label",
          id: label.id,
          args: label.args,
        });
        groupAriaLabel?.setAttribute("aria-label", item.getAttribute("label"));
      } else {
        this.#removeElementL10n(item, { attribute: "label" });
        groupAriaLabel?.removeAttribute("aria-label");
      }
    }

    let selectableElement = this.#getFirstSelectableElement();
    let uiIndex = 0;
    while (selectableElement) {
      selectableElement.elementIndex = uiIndex++;
      selectableElement = this.#getNextSelectableElement(selectableElement);
    }
    if (visibleRowsExist) {
      this.panel.removeAttribute("noresults");
    } else {
      this.panel.setAttribute("noresults", "true");
    }
  }

  /**
   * Returns the group label to use for a row. Designed to be called iteratively
   * over each row.
   *
   * @param {Element} row
   *   A row in the view.
   * @param {object} currentLabel
   *   The current group label during row iteration.
   * @returns {object}
   *   If the current row should not have a label, returns null. Otherwise
   *   returns an l10n object for the label's l10n string: `{ id, args }`
   */
  #rowLabel(row, currentLabel) {
    // Labels aren't shown for top sites, i.e., when the search string is empty.
    if (
      lazy.UrlbarPrefs.get("groupLabels.enabled") &&
      this.#queryContext?.searchString &&
      !row.result.heuristic
    ) {
      if (row.result.isBestMatch) {
        return { id: "urlbar-group-best-match" };
      }
      switch (row.result.type) {
        case lazy.UrlbarUtils.RESULT_TYPE.KEYWORD:
        case lazy.UrlbarUtils.RESULT_TYPE.REMOTE_TAB:
        case lazy.UrlbarUtils.RESULT_TYPE.TAB_SWITCH:
        case lazy.UrlbarUtils.RESULT_TYPE.URL:
          return { id: "urlbar-group-firefox-suggest" };
        case lazy.UrlbarUtils.RESULT_TYPE.SEARCH:
          // Show "{ $engine } suggestions" if it's not the first label.
          if (currentLabel && row.result.payload.suggestion) {
            let engineName =
              row.result.payload.engine || Services.search.defaultEngine.name;
            return {
              id: "urlbar-group-search-suggestions",
              args: { engine: engineName },
            };
          }
          break;
        case lazy.UrlbarUtils.RESULT_TYPE.DYNAMIC:
          if (row.result.providerName == "quickactions") {
            return { id: "urlbar-group-quickactions" };
          }
          break;
      }
    }
    return null;
  }

  #setRowVisibility(row, visible) {
    row.style.display = visible ? "" : "none";
    if (
      !visible &&
      row.result.type != lazy.UrlbarUtils.RESULT_TYPE.TIP &&
      row.result.type != lazy.UrlbarUtils.RESULT_TYPE.DYNAMIC
    ) {
      // Reset the overflow state of elements that can overflow in case their
      // content changes while they're hidden. When making the row visible
      // again, we'll get new overflow events if needed.
      this.#setElementOverflowing(row._elements.get("title"), false);
      this.#setElementOverflowing(row._elements.get("url"), false);
      let tagsContainer = row._elements.get("tagsContainer");
      if (tagsContainer) {
        this.#setElementOverflowing(tagsContainer, false);
      }
    }
  }

  /**
   * Returns true if the given element and its row are both visible.
   *
   * @param {Element} element
   *   An element in the view.
   * @returns {boolean}
   *   True if the given element and its row are both visible.
   */
  #isElementVisible(element) {
    if (!element || element.style.display == "none") {
      return false;
    }
    let row = element.closest(".urlbarView-row");
    return row && row.style.display != "none";
  }

  #removeStaleRows() {
    let row = this.#rows.lastElementChild;
    while (row) {
      let next = row.previousElementSibling;
      if (row.hasAttribute("stale")) {
        row.remove();
      } else {
        this.#setRowVisibility(row, true);
      }
      row = next;
    }
    this.#updateIndices();
  }

  #startRemoveStaleRowsTimer() {
    this.#removeStaleRowsTimer = this.window.setTimeout(() => {
      this.#removeStaleRowsTimer = null;
      this.#removeStaleRows();
    }, UrlbarView.removeStaleRowsTimeout);
  }

  #cancelRemoveStaleRowsTimer() {
    if (this.#removeStaleRowsTimer) {
      this.window.clearTimeout(this.#removeStaleRowsTimer);
      this.#removeStaleRowsTimer = null;
    }
  }

  #selectElement(
    element,
    { updateInput = true, setAccessibleFocus = true } = {}
  ) {
    if (this.#selectedElement) {
      this.#selectedElement.toggleAttribute("selected", false);
      this.#selectedElement.removeAttribute("aria-selected");
    }
    if (element) {
      element.toggleAttribute("selected", true);
      element.setAttribute("aria-selected", "true");
    }
    this.#setAccessibleFocus(setAccessibleFocus && element);
    this.#selectedElement = element;

    let result = element?.closest(".urlbarView-row")?.result;
    if (updateInput) {
      let urlOverride = null;
      if (element?.classList?.contains("urlbarView-button-help")) {
        urlOverride = result.payload.helpUrl;
      } else if (element?.classList?.contains("urlbarView-button")) {
        // Clear the input when a button is selected.
        urlOverride = "";
      }
      this.input.setValueFromResult({ result, urlOverride });
    } else {
      this.input.setResultForCurrentValue(result);
    }

    let provider = lazy.UrlbarProvidersManager.getProvider(
      result?.providerName
    );
    if (provider) {
      provider.tryMethod("onSelection", result, element);
    }
  }

  /**
   * Returns the element closest to the given element that can be
   * selected/picked.  If the element itself can be selected, it's returned.  If
   * there is no such element, null is returned.
   *
   * @param {Element} element
   *   An element in the view.
   * @returns {Element}
   *   The closest element that can be picked including the element itself, or
   *   null if there is no such element.
   */
  #getClosestSelectableElement(element) {
    let closest = element.closest(SELECTABLE_ELEMENT_SELECTOR);
    if (!closest) {
      let row = element.closest(".urlbarView-row");
      if (row && row.querySelector(UNSELECTABLE_ELEMENT_SELECTOR)) {
        return null;
      } else if (row && !row.querySelector(SELECTABLE_ELEMENT_SELECTOR)) {
        closest = row;
      }
    }
    return this.#isElementVisible(closest) ? closest : null;
  }

  /**
   * Returns true if the given element is selectable.
   *
   * @param {Element} element
   *   The element to test.
   * @returns {boolean}
   *   True if the element is selectable and false if not.
   */
  #isSelectableElement(element) {
    return this.#getClosestSelectableElement(element) == element;
  }

  /**
   * Returns the first selectable element in the view.
   *
   * @returns {Element}
   *   The first selectable element in the view.
   */
  #getFirstSelectableElement() {
    let element = this.#rows.firstElementChild;
    if (element && !this.#isSelectableElement(element)) {
      element = this.#getNextSelectableElement(element);
    }
    return element;
  }

  /**
   * Returns the last selectable element in the view.
   *
   * @returns {Element}
   *   The last selectable element in the view.
   */
  #getLastSelectableElement() {
    let row = this.#rows.lastElementChild;
    if (!row) {
      return null;
    }
    let selectables = row.querySelectorAll(SELECTABLE_ELEMENT_SELECTOR);
    let element = selectables.length
      ? selectables[selectables.length - 1]
      : row;

    if (element && !this.#isSelectableElement(element)) {
      element = this.#getPreviousSelectableElement(element);
    }
    return element;
  }

  /**
   * Returns the next selectable element after the given element.  If the
   * element is the last selectable element, returns null.
   *
   * @param {Element} element
   *   An element in the view.
   * @returns {Element}
   *   The next selectable element after `element` or null if `element` is the
   *   last selectable element.
   */
  #getNextSelectableElement(element) {
    let row = element.closest(".urlbarView-row");
    if (!row) {
      return null;
    }

    let next = row.nextElementSibling;
    let selectables = [...row.querySelectorAll(SELECTABLE_ELEMENT_SELECTOR)];
    if (selectables.length) {
      let index = selectables.indexOf(element);
      if (index < selectables.length - 1) {
        next = selectables[index + 1];
      }
    }

    if (next && !this.#isSelectableElement(next)) {
      next = this.#getNextSelectableElement(next);
    }

    return next;
  }

  /**
   * Returns the previous selectable element before the given element.  If the
   * element is the first selectable element, returns null.
   *
   * @param {Element} element
   *   An element in the view.
   * @returns {Element}
   *   The previous selectable element before `element` or null if `element` is
   *   the first selectable element.
   */
  #getPreviousSelectableElement(element) {
    let row = element.closest(".urlbarView-row");
    if (!row) {
      return null;
    }

    let previous = row.previousElementSibling;
    let selectables = [...row.querySelectorAll(SELECTABLE_ELEMENT_SELECTOR)];
    if (selectables.length) {
      let index = selectables.indexOf(element);
      if (index < 0) {
        previous = selectables[selectables.length - 1];
      } else if (index > 0) {
        previous = selectables[index - 1];
      }
    }

    if (previous && !this.#isSelectableElement(previous)) {
      previous = this.#getPreviousSelectableElement(previous);
    }

    return previous;
  }

  /**
   * Returns the currently selected row. Useful when this.#selectedElement may
   * be a non-row element, such as a descendant element of RESULT_TYPE.TIP.
   *
   * @returns {Element}
   *   The currently selected row, or ancestor row of the currently selected
   *   item.
   */
  #getSelectedRow() {
    if (!this.isOpen || !this.#selectedElement) {
      return null;
    }
    let selected = this.#selectedElement;

    if (!selected.classList.contains("urlbarView-row")) {
      // selected may be an element in a result group, like RESULT_TYPE.TIP.
      selected = selected.closest(".urlbarView-row");
    }

    return selected;
  }

  /**
   * @param {Element} element
   *   An element that is potentially a row or descendant of a row.
   * @returns {Element}
   *   The row containing `element`, or `element` itself if it is a row.
   */
  #getRowFromElement(element) {
    if (!this.isOpen || !element) {
      return null;
    }

    if (!element.classList.contains("urlbarView-row")) {
      element = element.closest(".urlbarView-row");
    }

    return element;
  }

  #setAccessibleFocus(item) {
    if (item) {
      this.input.inputField.setAttribute("aria-activedescendant", item.id);
    } else {
      this.input.inputField.removeAttribute("aria-activedescendant");
    }
  }

  /**
   * Sets `result`'s title in `titleNode`'s DOM.
   *
   * @param {UrlbarResult} result
   *   The result for which the title is being set.
   * @param {Node} titleNode
   *   The DOM node for the result's tile.
   */
  #setResultTitle(result, titleNode) {
    if (result.payload.providesSearchMode) {
      // Keyword offers are the only result that require a localized title.
      // We localize the title instead of using the action text as a title
      // because some keyword offer results use both a title and action text
      // (e.g. tab-to-search).
      this.#setElementL10n(titleNode, {
        id: "urlbar-result-action-search-w-engine",
        args: { engine: result.payload.engine },
      });
      return;
    }

    this.#removeElementL10n(titleNode);
    this.#addTextContentWithHighlights(
      titleNode,
      result.title,
      result.titleHighlights
    );
  }

  /**
   * Adds text content to a node, placing substrings that should be highlighted
   * inside <em> nodes.
   *
   * @param {Node} parentNode
   *   The text content will be added to this node.
   * @param {string} textContent
   *   The text content to give the node.
   * @param {Array} highlights
   *   The matches to highlight in the text.
   */
  #addTextContentWithHighlights(parentNode, textContent, highlights) {
    parentNode.textContent = "";
    if (!textContent) {
      return;
    }
    highlights = (highlights || []).concat([[textContent.length, 0]]);
    let index = 0;
    for (let [highlightIndex, highlightLength] of highlights) {
      if (highlightIndex - index > 0) {
        parentNode.appendChild(
          this.document.createTextNode(
            textContent.substring(index, highlightIndex)
          )
        );
      }
      if (highlightLength > 0) {
        let strong = this.#createElement("strong");
        strong.textContent = textContent.substring(
          highlightIndex,
          highlightIndex + highlightLength
        );
        parentNode.appendChild(strong);
      }
      index = highlightIndex + highlightLength;
    }
  }

  /**
   * Adds markup for a tail suggestion prefix to a row.
   *
   * @param {Node} item
   *   The node for the result row.
   * @param {UrlbarResult} result
   *   A UrlbarResult representing a tail suggestion.
   */
  #fillTailSuggestionPrefix(item, result) {
    let tailPrefixStrNode = item._elements.get("tailPrefixStr");
    let tailPrefixStr = result.payload.suggestion.substring(
      0,
      result.payload.tailOffsetIndex
    );
    tailPrefixStrNode.textContent = tailPrefixStr;

    let tailPrefixCharNode = item._elements.get("tailPrefixChar");
    tailPrefixCharNode.textContent = result.payload.tailPrefix;
  }

  #enableOrDisableRowWrap() {
    if (getBoundsWithoutFlushing(this.input.textbox).width < 650) {
      this.#rows.setAttribute("wrap", "true");
    } else {
      this.#rows.removeAttribute("wrap");
    }
  }

  #setElementOverflowing(element, overflowing) {
    element.toggleAttribute("overflow", overflowing);
    if (overflowing) {
      element.setAttribute("title", element._tooltip);
    } else {
      element.removeAttribute("title");
    }
  }

  /**
   * If the view is open and showing a single search tip, this method picks it
   * and closes the view.  This counts as an engagement, so this method should
   * only be called due to user interaction.
   *
   * @param {event} event
   *   The user-initiated event for the interaction.  Should not be null.
   * @returns {boolean}
   *   True if this method picked a tip, false otherwise.
   */
  #pickSearchTipIfPresent(event) {
    if (
      !this.isOpen ||
      !this.#queryContext ||
      this.#queryContext.results.length != 1
    ) {
      return false;
    }
    let result = this.#queryContext.results[0];
    if (result.type != lazy.UrlbarUtils.RESULT_TYPE.TIP) {
      return false;
    }
    let tipButton = this.#rows.firstElementChild.querySelector(
      ".urlbarView-tip-button"
    );
    if (!tipButton) {
      throw new Error("Expected a tip button");
    }
    this.input.pickElement(tipButton, event);
    return true;
  }

  /**
   * Caches some l10n strings used by the view. Strings that are already cached
   * are not cached again.
   *
   * Note:
   *   Currently strings are never evicted from the cache, so do not cache
   *   strings whose arguments include the search string or other values that
   *   can cause the cache to grow unbounded. Suitable strings include those
   *   without arguments or those whose arguments depend on a small set of
   *   static values like search engine names.
   */
  async #cacheL10nStrings() {
    let idArgs = [
      ...this.#cacheL10nIDArgsForSearchService(),
      { id: "urlbar-result-action-search-bookmarks" },
      { id: "urlbar-result-action-search-history" },
      { id: "urlbar-result-action-search-in-private" },
      { id: "urlbar-result-action-search-tabs" },
      { id: "urlbar-result-action-switch-tab" },
      { id: "urlbar-result-action-visit" },
    ];

    if (lazy.UrlbarPrefs.get("groupLabels.enabled")) {
      idArgs.push({ id: "urlbar-group-firefox-suggest" });
      if (
        lazy.UrlbarPrefs.get("bestMatchEnabled") &&
        lazy.UrlbarPrefs.get("suggest.bestmatch")
      ) {
        idArgs.push({ id: "urlbar-group-best-match" });
      }
    }

    if (
      lazy.UrlbarPrefs.get("quickSuggestEnabled") &&
      lazy.UrlbarPrefs.get("suggest.quicksuggest.sponsored")
    ) {
      idArgs.push({ id: "urlbar-result-action-sponsored" });
    }

    await this.#l10nCache.ensureAll(idArgs);
  }

  /**
   * A helper for l10n string caching that returns `{ id, args }` objects for
   * strings that depend on the search service.
   *
   * @returns {Array}
   *   Array of `{ id, args }` objects, possibly empty.
   */
  #cacheL10nIDArgsForSearchService() {
    // The search service may not be initialized if the user opens the view very
    // quickly after startup. Skip caching related strings in that case. Strings
    // are cached opportunistically every time the view opens, so they'll be
    // cached soon. We could use the search service's async methods, which
    // internally await initialization, but that would allow previously cached
    // out-of-date strings to appear in the view while the async calls are
    // ongoing. Generally there's no reason for our string-caching paths to be
    // async and it may even be a bad idea (except for the final necessary
    // `this.#l10nCache.ensureAll()` call).
    if (!Services.search.isInitialized) {
      return [];
    }

    let idArgs = [];

    let { defaultEngine, defaultPrivateEngine } = Services.search;
    let engineNames = [defaultEngine?.name, defaultPrivateEngine?.name].filter(
      name => name
    );

    if (defaultPrivateEngine) {
      idArgs.push({
        id: "urlbar-result-action-search-in-private-w-engine",
        args: { engine: defaultPrivateEngine.name },
      });
    }

    let engineStringIDs = [
      "urlbar-result-action-tabtosearch-web",
      "urlbar-result-action-tabtosearch-other-engine",
      "urlbar-result-action-search-w-engine",
    ];
    for (let id of engineStringIDs) {
      idArgs.push(...engineNames.map(name => ({ id, args: { engine: name } })));
    }

    if (lazy.UrlbarPrefs.get("groupLabels.enabled")) {
      idArgs.push(
        ...engineNames.map(name => ({
          id: "urlbar-group-search-suggestions",
          args: { engine: name },
        }))
      );
    }

    return idArgs;
  }

  /**
   * Sets an element's textContent or attribute to a cached l10n string. If the
   * string isn't cached, then this falls back to the async `l10n.setAttributes`
   * using the given l10n ID and args. The string will pop in as a result, but
   * there's no way around it.
   *
   * @param {Element} element
   *   The element to set.
   * @param {object} options
   *   Options object.
   * @param {string} options.id
   *   The l10n string ID.
   * @param {object} [options.args]
   *   The l10n string arguments.
   * @param {string} [options.attribute]
   *   If you're setting an attribute string, then pass the name of the
   *   attribute. In that case, the string in the Fluent file should define a
   *   value for the attribute, like ".foo = My value for the foo attribute".
   *   If you're setting the element's textContent, then leave this undefined.
   */
  #setElementL10n(element, { id, args = undefined, attribute = undefined }) {
    let message = this.#l10nCache.get(id, args);
    if (message) {
      element.removeAttribute("data-l10n-id");
      if (attribute) {
        element.setAttribute(attribute, message.attributes[attribute]);
      } else {
        element.textContent = message.value;
      }
    } else {
      if (attribute) {
        element.setAttribute("data-l10n-attrs", attribute);
      }
      this.document.l10n.setAttributes(element, id, args);
    }
  }

  /**
   * Removes textContent and attributes set by `#setElementL10n`.
   *
   * @param {Element} element
   *   The element that should be acted on
   * @param {object} options
   *   Options object
   * @param {string} [options.attribute]
   *   If you passed an attribute to `#setElementL10n`, then pass it here too.
   */
  #removeElementL10n(element, { attribute = undefined } = {}) {
    if (attribute) {
      element.removeAttribute(attribute);
      element.removeAttribute("data-l10n-attrs");
    } else {
      element.textContent = "";
    }
    element.removeAttribute("data-l10n-id");
  }

  // Event handlers below.

  on_SelectedOneOffButtonChanged() {
    if (!this.isOpen || !this.#queryContext) {
      return;
    }

    let engine = this.oneOffSearchButtons.selectedButton?.engine;
    let source = this.oneOffSearchButtons.selectedButton?.source;

    let localSearchMode;
    if (source) {
      localSearchMode = lazy.UrlbarUtils.LOCAL_SEARCH_MODES.find(
        m => m.source == source
      );
    }

    for (let item of this.#rows.children) {
      let result = item.result;

      let isPrivateSearchWithoutPrivateEngine =
        result.payload.inPrivateWindow && !result.payload.isPrivateEngine;
      let isSearchHistory =
        result.type == lazy.UrlbarUtils.RESULT_TYPE.SEARCH &&
        result.source == lazy.UrlbarUtils.RESULT_SOURCE.HISTORY;
      let isSearchSuggestion = result.payload.suggestion && !isSearchHistory;

      // For one-off buttons having a source, we update the action for the
      // heuristic result, or for any non-heuristic that is a remote search
      // suggestion or a private search with no private engine.
      if (
        !result.heuristic &&
        !isSearchSuggestion &&
        !isPrivateSearchWithoutPrivateEngine
      ) {
        continue;
      }

      // If there is no selected button and we are in full search mode, it is
      // because the user just confirmed a one-off button, thus starting a new
      // query. Don't change the heuristic result because it would be
      // immediately replaced with the search mode heuristic, causing flicker.
      if (
        result.heuristic &&
        !engine &&
        !localSearchMode &&
        this.input.searchMode &&
        !this.input.searchMode.isPreview
      ) {
        continue;
      }

      let action = item.querySelector(".urlbarView-action");
      let favicon = item.querySelector(".urlbarView-favicon");
      let title = item.querySelector(".urlbarView-title");

      // If a one-off button is the only selection, force the heuristic result
      // to show its action text, so the engine name is visible.
      if (
        result.heuristic &&
        !this.selectedElement &&
        (localSearchMode || engine)
      ) {
        item.setAttribute("show-action-text", "true");
      } else {
        item.removeAttribute("show-action-text");
      }

      // If an engine is selected, update search results to use that engine.
      // Otherwise, restore their original engines.
      if (result.type == lazy.UrlbarUtils.RESULT_TYPE.SEARCH) {
        if (engine) {
          if (!result.payload.originalEngine) {
            result.payload.originalEngine = result.payload.engine;
          }
          result.payload.engine = engine.name;
        } else if (result.payload.originalEngine) {
          result.payload.engine = result.payload.originalEngine;
          delete result.payload.originalEngine;
        }
      }

      // If the result is the heuristic and a one-off is selected (i.e.,
      // localSearchMode || engine), then restyle it to look like a search
      // result; otherwise, remove such styling. For restyled results, we
      // override the usual result-picking behaviour in UrlbarInput.pickResult.
      if (result.heuristic) {
        title.textContent =
          localSearchMode || engine
            ? this.#queryContext.searchString
            : result.title;

        // Set the restyled-search attribute so the action text and title
        // separator are shown or hidden via CSS as appropriate.
        if (localSearchMode || engine) {
          item.setAttribute("restyled-search", "true");
        } else {
          item.removeAttribute("restyled-search");
        }
      }

      // Update result action text.
      if (localSearchMode) {
        // Update the result action text for a local one-off.
        let name = lazy.UrlbarUtils.getResultSourceName(localSearchMode.source);
        this.#setElementL10n(action, {
          id: `urlbar-result-action-search-${name}`,
        });
        if (result.heuristic) {
          item.setAttribute("source", name);
        }
      } else if (engine && !result.payload.inPrivateWindow) {
        // Update the result action text for an engine one-off.
        this.#setElementL10n(action, {
          id: "urlbar-result-action-search-w-engine",
          args: { engine: engine.name },
        });
      } else {
        // No one-off is selected. If we replaced the action while a one-off
        // button was selected, it should be restored.
        if (item._originalActionSetter) {
          item._originalActionSetter();
          if (result.heuristic) {
            favicon.src = result.payload.icon || lazy.UrlbarUtils.ICON.DEFAULT;
          }
        } else {
          Cu.reportError("An item is missing the action setter");
        }
        item.removeAttribute("source");
      }

      // Update result favicons.
      let iconOverride = localSearchMode?.icon || engine?.iconURI?.spec;
      if (!iconOverride && (localSearchMode || engine)) {
        // For one-offs without an icon, do not allow restyled URL results to
        // use their own icons.
        iconOverride = lazy.UrlbarUtils.ICON.SEARCH_GLASS;
      }
      if (
        result.heuristic ||
        (result.payload.inPrivateWindow && !result.payload.isPrivateEngine)
      ) {
        // If we just changed the engine from the original engine and it had an
        // icon, then make sure the result now uses the new engine's icon or
        // failing that the default icon.  If we changed it back to the original
        // engine, go back to the original or default icon.
        favicon.src = this.#iconForResult(result, iconOverride);
      }
    }
  }

  on_blur(event) {
    // If the view is open without the input being focused, it will not close
    // automatically when the window loses focus. We might be in this state
    // after a Search Tip is shown on an engine homepage.
    if (!lazy.UrlbarPrefs.get("ui.popup.disable_autohide")) {
      this.close();
    }
  }

  on_mousedown(event) {
    if (event.button == 2) {
      // Ignore right clicks.
      return;
    }

    let element = this.#getClosestSelectableElement(event.target);
    if (!element) {
      // Ignore clicks on elements that can't be selected/picked.
      return;
    }

    this.window.top.addEventListener("mouseup", this);
    this.#selectElement(element, { updateInput: false });

    this.controller.speculativeConnect(
      this.selectedResult,
      this.#queryContext,
      "mousedown"
    );
  }

  on_mouseup(event) {
    if (event.button == 2) {
      // Ignore right clicks.
      return;
    }

    this.window.top.removeEventListener("mouseup", this);

    // When mouseup outside of browser, as the target will not be element,
    // ignore it.
    let element =
      event.target.nodeType === event.target.ELEMENT_NODE
        ? this.#getClosestSelectableElement(event.target)
        : null;
    if (element) {
      this.input.pickElement(element, event);
    }

    // Unselect the selected element here because pickElement() may use the
    // selected element.
    this.#selectElement(null);
  }

  on_overflow(event) {
    if (
      event.detail == 1 &&
      (event.target.classList.contains("urlbarView-url") ||
        event.target.classList.contains("urlbarView-title") ||
        event.target.classList.contains("urlbarView-tags"))
    ) {
      this.#setElementOverflowing(event.target, true);
    }
  }

  on_underflow(event) {
    if (
      event.detail == 1 &&
      (event.target.classList.contains("urlbarView-url") ||
        event.target.classList.contains("urlbarView-title") ||
        event.target.classList.contains("urlbarView-tags"))
    ) {
      this.#setElementOverflowing(event.target, false);
    }
  }

  on_resize() {
    this.#enableOrDisableRowWrap();
  }

  on_command(event) {
    if (event.currentTarget == this.#resultMenu) {
      let result = this.#resultMenuResult;
      let menuitem = event.target;
      switch (menuitem.dataset.command) {
        case "test":
          console.log(result);
          break;
      }
    }
  }
}

/**
 * Implements a QueryContext cache, working as a circular buffer, when a new
 * entry is added at the top, the last item is remove from the bottom.
 */
class QueryContextCache {
  #cache;
  #size;
  #topSitesContext;
  #topSitesListener;

  /**
   * Constructor.
   *
   * @param {number} size The number of entries to keep in the cache.
   */
  constructor(size) {
    this.#size = size;
    this.#cache = [];

    // We store the top-sites context separately since it will often be needed
    // and therefore shouldn't be evicted except when the top sites change.
    this.#topSitesContext = null;
    this.#topSitesListener = () => (this.#topSitesContext = null);
    lazy.UrlbarProviderTopSites.addTopSitesListener(this.#topSitesListener);
  }

  /**
   * @returns {number} The number of entries to keep in the cache.
   */
  get size() {
    return this.#size;
  }

  /**
   * @returns {UrlbarQueryContext} The cached top-sites context or null if none.
   */
  get topSitesContext() {
    return this.#topSitesContext;
  }

  /**
   * Adds a new entry to the cache.
   *
   * @param {UrlbarQueryContext} queryContext The UrlbarQueryContext to add.
   * Note: QueryContexts without results are ignored and not added. Contexts
   *       with an empty searchString that are not the top-sites context are
   *       also ignored.
   */
  put(queryContext) {
    if (!queryContext.results.length) {
      return;
    }

    let searchString = queryContext.searchString;
    if (!searchString) {
      // Cache the context if it's the top-sites context. An empty search string
      // doesn't necessarily imply top sites since there are other queries that
      // use it too, like search mode. If the first result is from the top-sites
      // provider, assume the context is top sites.
      if (
        queryContext.results?.[0]?.providerName ==
        lazy.UrlbarProviderTopSites.name
      ) {
        this.#topSitesContext = queryContext;
      }
      return;
    }

    let index = this.#cache.findIndex(e => e.searchString == searchString);
    if (index != -1) {
      if (this.#cache[index] == queryContext) {
        return;
      }
      this.#cache.splice(index, 1);
    }
    if (this.#cache.unshift(queryContext) > this.size) {
      this.#cache.length = this.size;
    }
  }

  get(searchString) {
    return this.#cache.find(e => e.searchString == searchString);
  }
}

/**
 * Adds a dynamic result type stylesheet to a specified window.
 *
 * @param {Window} window
 *   The window to which to add the stylesheet.
 * @param {string} stylesheetURL
 *   The stylesheet's URL.
 */
async function addDynamicStylesheet(window, stylesheetURL) {
  // Try-catch all of these so that failing to load a stylesheet doesn't break
  // callers and possibly the urlbar.  If a stylesheet does fail to load, the
  // dynamic results that depend on it will appear broken, but at least we
  // won't break the whole urlbar.
  try {
    let uri = Services.io.newURI(stylesheetURL);
    let sheet = await lazy.styleSheetService.preloadSheetAsync(
      uri,
      Ci.nsIStyleSheetService.AGENT_SHEET
    );
    window.windowUtils.addSheet(sheet, Ci.nsIDOMWindowUtils.AGENT_SHEET);
  } catch (ex) {
    Cu.reportError(`Error adding dynamic stylesheet: ${ex}`);
  }
}

/**
 * Removes a dynamic result type stylesheet from the view's window.
 *
 * @param {Window} window
 *   The window from which to remove the stylesheet.
 * @param {string} stylesheetURL
 *   The stylesheet's URL.
 */
function removeDynamicStylesheet(window, stylesheetURL) {
  // Try-catch for the same reason as desribed in addDynamicStylesheet.
  try {
    window.windowUtils.removeSheetUsingURIString(
      stylesheetURL,
      Ci.nsIDOMWindowUtils.AGENT_SHEET
    );
  } catch (ex) {
    Cu.reportError(`Error removing dynamic stylesheet: ${ex}`);
  }
}
