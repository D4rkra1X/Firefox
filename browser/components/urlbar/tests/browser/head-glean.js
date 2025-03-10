/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

/* import-globals-from head.js */

ChromeUtils.defineESModuleGetters(this, {
  QuickSuggest: "resource:///modules/QuickSuggest.sys.mjs",
});

XPCOMUtils.defineLazyGetter(this, "QuickSuggestTestUtils", () => {
  const { QuickSuggestTestUtils: Utils } = ChromeUtils.importESModule(
    "resource://testing-common/QuickSuggestTestUtils.sys.mjs"
  );
  return new Utils(this);
});

async function addTopSites(url) {
  for (let i = 0; i < 5; i++) {
    await PlacesTestUtils.addVisits(url);
  }
  await updateTopSites(sites => {
    return sites && sites[0] && sites[0].url == url;
  });
}

function assertAbandonmentTelemetry(expectedExtraList) {
  _assertGleanTelemetry("abandonment", expectedExtraList);
}

function assertEngagementTelemetry(expectedExtraList) {
  _assertGleanTelemetry("engagement", expectedExtraList);
}

function _assertGleanTelemetry(telemetryName, expectedExtraList) {
  const telemetries = Glean.urlbar[telemetryName].testGetValue() ?? [];
  Assert.equal(telemetries.length, expectedExtraList.length);

  for (let i = 0; i < telemetries.length; i++) {
    const telemetry = telemetries[i];
    Assert.equal(telemetry.category, "urlbar");
    Assert.equal(telemetry.name, telemetryName);

    const expectedExtra = expectedExtraList[i];
    for (const key of Object.keys(expectedExtra)) {
      Assert.equal(
        telemetry.extra[key],
        expectedExtra[key],
        `${key} is correct`
      );
    }
  }
}

async function ensureQuickSuggestInit() {
  return QuickSuggestTestUtils.ensureQuickSuggestInit([
    {
      id: 1,
      url: "https://example.com/sponsored",
      title: "Sponsored suggestion",
      keywords: ["sponsored"],
      click_url: "https://example.com/click",
      impression_url: "https://example.com/impression",
      advertiser: "TestAdvertiser",
      iab_category: "22 - Shopping",
    },
    {
      id: 2,
      url: `https://example.com/nonsponsored`,
      title: "Non-sponsored suggestion",
      keywords: ["nonsponsored"],
      click_url: "https://example.com/click",
      impression_url: "https://example.com/impression",
      advertiser: "TestAdvertiser",
      iab_category: "5 - Education",
    },
  ]);
}

async function doTest(testFn) {
  Services.fog.testResetFOG();
  gURLBar.controller.engagementEvent.discard();
  await PlacesUtils.history.clear();
  await PlacesUtils.bookmarks.eraseEverything();
  await PlacesTestUtils.clearHistoryVisits();
  await PlacesTestUtils.clearInputHistory();
  await UrlbarTestUtils.formHistory.clear(window);
  await QuickSuggest.blockedSuggestions.clear();
  await QuickSuggest.blockedSuggestions._test_readyPromise;
  await updateTopSites(() => true);

  await BrowserTestUtils.withNewTab(gBrowser, testFn);
}

async function doBlur() {
  await UrlbarTestUtils.promisePopupClose(window, () => {
    gURLBar.blur();
  });
}

async function doClick() {
  const selected = UrlbarTestUtils.getSelectedRow(window);
  const onLoad = BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
  EventUtils.synthesizeMouseAtCenter(selected, {});
  await onLoad;
}

async function doClickSubButton(selector) {
  const selected = UrlbarTestUtils.getSelectedElement(window);
  const button = selected.querySelector(selector);
  EventUtils.synthesizeMouseAtCenter(button, {});
}

async function doDropAndGo(data) {
  const onLoad = BrowserTestUtils.browserLoaded(browser);
  EventUtils.synthesizeDrop(
    document.getElementById("back-button"),
    gURLBar.inputField,
    [[{ type: "text/plain", data }]],
    "copy",
    window
  );
  await onLoad;
}

async function doEnter() {
  const onLoad = BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
  EventUtils.synthesizeKey("KEY_Enter");
  await onLoad;
}

async function doPaste(data) {
  await SimpleTest.promiseClipboardChange(data, () => {
    clipboardHelper.copyString(data);
  });

  gURLBar.focus();
  gURLBar.select();
  document.commandDispatcher
    .getControllerForCommand("cmd_paste")
    .doCommand("cmd_paste");
}

async function doPasteAndGo(data) {
  await SimpleTest.promiseClipboardChange(data, () => {
    clipboardHelper.copyString(data);
  });
  const inputBox = gURLBar.querySelector("moz-input-box");
  const contextMenu = inputBox.menupopup;
  const onPopup = BrowserTestUtils.waitForEvent(contextMenu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(gURLBar.inputField, {
    type: "contextmenu",
    button: 2,
  });
  await onPopup;
  const onLoad = BrowserTestUtils.browserLoaded(browser);
  const menuitem = inputBox.getMenuItem("paste-and-go");
  contextMenu.activateItem(menuitem);
  await onLoad;
}

function loadOmniboxAddon({ keyword }) {
  return ExtensionTestUtils.loadExtension({
    manifest: {
      permissions: ["tabs"],
      omnibox: {
        keyword,
      },
    },
    background() {
      /* global browser */
      browser.omnibox.setDefaultSuggestion({
        description: "doit",
      });
      browser.omnibox.onInputEntered.addListener(() => {
        browser.tabs.update({ url: "https://example.com/" });
      });
      browser.omnibox.onInputChanged.addListener((text, suggest) => {
        suggest([]);
      });
    },
  });
}

async function loadRemoteTab(url) {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["browser.urlbar.suggest.searches", false],
      ["browser.urlbar.maxHistoricalSearchSuggestions", 0],
      ["browser.urlbar.autoFill", false],
      ["services.sync.username", "fake"],
      ["services.sync.syncedTabs.showRemoteTabs", true],
    ],
  });

  const REMOTE_TAB = {
    id: "test",
    type: "client",
    lastModified: 1492201200,
    name: "test",
    clientType: "desktop",
    tabs: [
      {
        type: "tab",
        title: "tesrt",
        url,
        icon: UrlbarUtils.ICON.DEFAULT,
        client: "test",
        lastUsed: Math.floor(Date.now() / 1000),
      },
    ],
  };

  const sandbox = sinon.createSandbox();
  // eslint-disable-next-line no-undef
  const syncedTabs = SyncedTabs;
  const originalSyncedTabsInternal = syncedTabs._internal;
  syncedTabs._internal = {
    isConfiguredToSyncTabs: true,
    hasSyncedThisSession: true,
    getTabClients() {
      return Promise.resolve([]);
    },
    syncTabs() {
      return Promise.resolve();
    },
  };
  const weaveXPCService = Cc["@mozilla.org/weave/service;1"].getService(
    Ci.nsISupports
  ).wrappedJSObject;
  const oldWeaveServiceReady = weaveXPCService.ready;
  weaveXPCService.ready = true;
  sandbox
    .stub(syncedTabs._internal, "getTabClients")
    .callsFake(() => Promise.resolve(Cu.cloneInto([REMOTE_TAB], {})));

  return {
    async unload() {
      sandbox.restore();
      weaveXPCService.ready = oldWeaveServiceReady;
      syncedTabs._internal = originalSyncedTabsInternal;
      // Reset internal cache in UrlbarProviderRemoteTabs.
      Services.obs.notifyObservers(null, "weave:engine:sync:finish", "tabs");
      await SpecialPowers.popPrefEnv();
    },
  };
}

async function openPopup(input) {
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: input,
    fireInputEvent: true,
  });
}

async function selectRowByURL(url) {
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const detail = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    if (detail.url === url) {
      UrlbarTestUtils.setSelectedRowIndex(window, i);
      return;
    }
  }
}

async function selectRowByProvider(provider) {
  for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
    const detail = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    if (detail.result.providerName === provider) {
      UrlbarTestUtils.setSelectedRowIndex(window, i);
      break;
    }
  }
}

async function setup() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.searchEngagementTelemetry.enabled", true]],
  });

  const engine = await SearchTestUtils.promiseNewSearchEngine({
    url: getRootDirectory(gTestPath) + "searchSuggestionEngine.xml",
  });
  const originalDefaultEngine = await Services.search.getDefault();
  await Services.search.setDefault(
    engine,
    Ci.nsISearchService.CHANGE_REASON_UNKNOWN
  );
  await Services.search.moveEngine(engine, 0);

  registerCleanupFunction(async function() {
    await SpecialPowers.popPrefEnv();
    await Services.search.setDefault(
      originalDefaultEngine,
      Ci.nsISearchService.CHANGE_REASON_UNKNOWN
    );
  });
}

async function showResultByArrowDown() {
  gURLBar.value = "";
  gURLBar.select();
  await UrlbarTestUtils.promisePopupOpen(window, () => {
    EventUtils.synthesizeKey("KEY_ArrowDown");
  });
  await UrlbarTestUtils.promiseSearchComplete(window);
}
