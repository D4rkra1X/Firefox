/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

/**
 * This file tests urlbar telemetry for Quick Suggest results.
 * See also browser_quicksuggest_onboardingDialog.js for onboarding telemetry.
 */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  UrlbarView: "resource:///modules/UrlbarView.sys.mjs",
});

XPCOMUtils.defineLazyModuleGetters(this, {
  CONTEXTUAL_SERVICES_PING_TYPES:
    "resource:///modules/PartnerLinkAttribution.jsm",
  NimbusFeatures: "resource://nimbus/ExperimentAPI.jsm",
  sinon: "resource://testing-common/Sinon.jsm",
  TelemetryEnvironment: "resource://gre/modules/TelemetryEnvironment.jsm",
});

const { TELEMETRY_SCALARS } = UrlbarProviderQuickSuggest;

const SUGGESTIONS = [
  {
    id: 1,
    url: "http://example.com/sponsored",
    title: "Sponsored suggestion",
    keywords: ["sponsored"],
    click_url: "http://example.com/click",
    impression_url: "http://example.com/impression",
    advertiser: "TestAdvertiser",
  },
  {
    id: 2,
    url: "http://example.com/nonsponsored",
    title: "Non-sponsored suggestion",
    keywords: ["nonsponsored"],
    click_url: "http://example.com/click",
    impression_url: "http://example.com/impression",
    advertiser: "TestAdvertiser",
    iab_category: "5 - Education",
  },
];

const SPONSORED_SUGGESTION = SUGGESTIONS[0];

// Spy for the custom impression/click sender
let spy;

// This is a thorough test that opens and closes many tabs and it can time out
// on slower CI machines in verify mode, so request a longer timeout.
requestLongerTimeout(5);

add_setup(async function() {
  ({ spy } = QuickSuggestTestUtils.createTelemetryPingSpy());

  await PlacesUtils.history.clear();
  await PlacesUtils.bookmarks.eraseEverything();
  await UrlbarTestUtils.formHistory.clear();

  Services.telemetry.clearScalars();
  Services.telemetry.clearEvents();

  // Add a mock engine so we don't hit the network.
  await SearchTestUtils.installSearchExtension({}, { setAsDefault: true });

  await QuickSuggestTestUtils.ensureQuickSuggestInit(SUGGESTIONS);
});

/**
 * Adds a test task that runs the given callback with each suggestion in
 * `SUGGESTIONS`.
 *
 * @param {Function} fn
 *   The callback function. It's passed the current suggestion.
 */
function add_suggestions_task(fn) {
  let taskFn = async () => {
    for (let suggestion of SUGGESTIONS) {
      info(`Running ${fn.name} with suggestion ${JSON.stringify(suggestion)}`);
      await fn(suggestion);
    }
  };
  Object.defineProperty(taskFn, "name", { value: fn.name });
  add_task(taskFn);
}

// Tests the following:
// * impression telemetry
// * offline scenario
// * data collection disabled by user
add_suggestions_task(async function impression_offline_dataCollectionDisabled(
  suggestion
) {
  await QuickSuggestTestUtils.setScenario("offline");
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", false);
  await doImpressionTest({
    suggestion,
    improve_suggest_experience_checked: false,
  });
});

// Tests the following:
// * impression telemetry
// * offline scenario
// * data collection enabled by user
add_suggestions_task(async function impression_offline_dataCollectionEnabled(
  suggestion
) {
  await QuickSuggestTestUtils.setScenario("offline");
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", true);
  await doImpressionTest({
    suggestion,
    improve_suggest_experience_checked: true,
  });
});

// Tests the following:
// * impression telemetry
// * online scenario
// * data collection disabled by user
add_suggestions_task(async function impression_online_dataCollectionDisabled(
  suggestion
) {
  await QuickSuggestTestUtils.setScenario("online");
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", false);
  UrlbarPrefs.set("suggest.quicksuggest.nonsponsored", true);
  UrlbarPrefs.set("suggest.quicksuggest.sponsored", true);
  await doImpressionTest({
    suggestion,
    improve_suggest_experience_checked: false,
  });
});

// Tests the following:
// * impression telemetry
// * online scenario
// * data collection enabled by user
add_suggestions_task(async function impression_online_dataCollectionEnabled(
  suggestion
) {
  await QuickSuggestTestUtils.setScenario("online");
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", true);
  UrlbarPrefs.set("suggest.quicksuggest.nonsponsored", true);
  UrlbarPrefs.set("suggest.quicksuggest.sponsored", true);
  await doImpressionTest({
    suggestion,
    improve_suggest_experience_checked: true,
  });
});

// Tests the following:
// * impression telemetry
// * best match
add_suggestions_task(async function impression_bestMatch(suggestion) {
  UrlbarPrefs.set("bestMatch.enabled", true);
  await doImpressionTest({
    suggestion,
    improve_suggest_experience_checked:
      QuickSuggestTestUtils.DATA_COLLECTION_OFFLINE,
    isBestMatch: true,
  });
  UrlbarPrefs.clear("bestMatch.enabled");
});

async function doImpressionTest({
  improve_suggest_experience_checked,
  suggestion,
  isBestMatch = false,
}) {
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    Services.telemetry.clearEvents();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: suggestion.keywords[0],
      fireInputEvent: true,
    });

    let index = 1;
    let isSponsored = suggestion.keywords[0] == "sponsored";
    await QuickSuggestTestUtils.assertIsQuickSuggest({
      window,
      index,
      isSponsored,
      isBestMatch,
      url: suggestion.url,
    });

    // Press Enter on the heuristic result, which is not the quick suggest, to
    // make sure we don't record click telemetry.
    await UrlbarTestUtils.promisePopupClose(window, () => {
      EventUtils.synthesizeKey("KEY_Enter");
    });

    let scalars = {
      [TELEMETRY_SCALARS.IMPRESSION]: index + 1,
    };
    if (isBestMatch) {
      if (isSponsored) {
        scalars = {
          ...scalars,
          [TELEMETRY_SCALARS.IMPRESSION_SPONSORED_BEST_MATCH]: index + 1,
        };
      } else {
        scalars = {
          ...scalars,
          [TELEMETRY_SCALARS.IMPRESSION_NONSPONSORED_BEST_MATCH]: index + 1,
        };
      }
    }
    QuickSuggestTestUtils.assertScalars(scalars);
    QuickSuggestTestUtils.assertEvents([
      {
        category: QuickSuggest.TELEMETRY_EVENT_CATEGORY,
        method: "engagement",
        object: "impression_only",
        extra: {
          match_type: isBestMatch ? "best-match" : "firefox-suggest",
          position: String(index + 1),
          suggestion_type: isSponsored ? "sponsored" : "nonsponsored",
        },
      },
    ]);
    QuickSuggestTestUtils.assertPings(spy, [
      {
        type: CONTEXTUAL_SERVICES_PING_TYPES.QS_IMPRESSION,
        payload: {
          improve_suggest_experience_checked,
          block_id: suggestion.id,
          is_clicked: false,
          match_type: isBestMatch ? "best-match" : "firefox-suggest",
          position: index + 1,
        },
      },
    ]);
  });

  await PlacesUtils.history.clear();
  await UrlbarTestUtils.formHistory.clear();

  await QuickSuggestTestUtils.setScenario(null);
  UrlbarPrefs.clear("quicksuggest.dataCollection.enabled");
  UrlbarPrefs.clear("suggest.quicksuggest.nonsponsored");
  UrlbarPrefs.clear("suggest.quicksuggest.sponsored");
}

// Makes sure impression telemetry is not recorded when the urlbar engagement is
// abandoned.
add_task(async function noImpression_abandonment() {
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    Services.telemetry.clearEvents();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "sponsored",
      fireInputEvent: true,
    });
    await QuickSuggestTestUtils.assertIsQuickSuggest({
      window,
      url: SPONSORED_SUGGESTION.url,
    });
    await UrlbarTestUtils.promisePopupClose(window, () => {
      gURLBar.blur();
    });
    QuickSuggestTestUtils.assertScalars({});
    QuickSuggestTestUtils.assertEvents([]);
    QuickSuggestTestUtils.assertPings(spy, []);
  });
});

// Makes sure impression telemetry is not recorded when a quick suggest result
// is not present.
add_task(async function noImpression_noQuickSuggestResult() {
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    Services.telemetry.clearEvents();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "noImpression_noQuickSuggestResult",
      fireInputEvent: true,
    });
    await QuickSuggestTestUtils.assertNoQuickSuggestResults(window);
    await UrlbarTestUtils.promisePopupClose(window, () => {
      EventUtils.synthesizeKey("KEY_Enter");
    });
    QuickSuggestTestUtils.assertScalars({});
    QuickSuggestTestUtils.assertEvents([]);
    QuickSuggestTestUtils.assertPings(spy, []);
  });
  await PlacesUtils.history.clear();
});

// Tests the following:
// * click telemetry using keyboard
// * offline scenario
// * data collection disabled by user
add_suggestions_task(
  async function click_keyboard_offline_dataCollectionDisabled(suggestion) {
    await QuickSuggestTestUtils.setScenario("offline");
    UrlbarPrefs.set("quicksuggest.dataCollection.enabled", false);
    await doClickTest({
      suggestion,
      improve_suggest_experience_checked: false,
      useKeyboard: true,
    });
  }
);

// Tests the following:
// * click telemetry using keyboard
// * offline scenario
// * data collection enabled by user
add_suggestions_task(
  async function click_keyboard_offline_dataCollectionEnabled(suggestion) {
    await QuickSuggestTestUtils.setScenario("offline");
    UrlbarPrefs.set("quicksuggest.dataCollection.enabled", true);
    await doClickTest({
      suggestion,
      improve_suggest_experience_checked: true,
      useKeyboard: true,
    });
  }
);

// Tests the following:
// * click telemetry using keyboard
// * online scenario
// * data collection disabled by user
add_suggestions_task(
  async function click_keyboard_online_dataCollectionDisabled(suggestion) {
    await QuickSuggestTestUtils.setScenario("online");
    UrlbarPrefs.set("quicksuggest.dataCollection.enabled", false);
    UrlbarPrefs.set("suggest.quicksuggest.nonsponsored", true);
    UrlbarPrefs.set("suggest.quicksuggest.sponsored", true);
    await doClickTest({
      suggestion,
      improve_suggest_experience_checked: false,
      useKeyboard: true,
    });
  }
);

// Tests the following:
// * click telemetry using keyboard
// * online scenario
// * data collection enabled by user
add_suggestions_task(async function click_keyboard_online_dataCollectionEnabled(
  suggestion
) {
  await QuickSuggestTestUtils.setScenario("online");
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", true);
  UrlbarPrefs.set("suggest.quicksuggest.nonsponsored", true);
  UrlbarPrefs.set("suggest.quicksuggest.sponsored", true);
  await doClickTest({
    suggestion,
    improve_suggest_experience_checked: true,
    useKeyboard: true,
  });
});

// Tests the following:
// * click telemetry using mouse
// * offline scenario
// * data collection disabled by user
add_suggestions_task(async function click_mouse_offline_dataCollectionDisabled(
  suggestion
) {
  await QuickSuggestTestUtils.setScenario("offline");
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", false);
  await doClickTest({
    suggestion,
    improve_suggest_experience_checked: false,
    useKeyboard: false,
  });
});

// Tests the following:
// * click telemetry using mouse
// * offline scenario
// * data collection enabled by user
add_suggestions_task(async function click_mouse_offline_dataCollectionEnabled(
  suggestion
) {
  await QuickSuggestTestUtils.setScenario("offline");
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", true);
  await doClickTest({
    suggestion,
    improve_suggest_experience_checked: true,
    useKeyboard: false,
  });
});

// Tests the following:
// * click telemetry using mouse
// * online scenario
// * data collection disabled by user
add_suggestions_task(async function click_mouse_online_dataCollectionDisabled(
  suggestion
) {
  await QuickSuggestTestUtils.setScenario("online");
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", false);
  UrlbarPrefs.set("suggest.quicksuggest.nonsponsored", true);
  UrlbarPrefs.set("suggest.quicksuggest.sponsored", true);
  await doClickTest({
    suggestion,
    improve_suggest_experience_checked: false,
    useKeyboard: false,
  });
});

// Tests the following:
// * click telemetry using mouse
// * online scenario
// * data collection enabled by user
add_suggestions_task(async function click_mouse_online_dataCollectionEnabled(
  suggestion
) {
  await QuickSuggestTestUtils.setScenario("online");
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", true);
  UrlbarPrefs.set("suggest.quicksuggest.nonsponsored", true);
  UrlbarPrefs.set("suggest.quicksuggest.sponsored", true);
  await doClickTest({
    suggestion,
    improve_suggest_experience_checked: true,
    useKeyboard: false,
  });
});

// Tests the following:
// * click telemetry using keyboard
// * best match
add_suggestions_task(async function click_keyboard_bestMatch(suggestion) {
  UrlbarPrefs.set("bestMatch.enabled", true);
  await doClickTest({
    suggestion,
    improve_suggest_experience_checked:
      QuickSuggestTestUtils.DATA_COLLECTION_OFFLINE,
    useKeyboard: true,
    isBestMatch: true,
  });
  UrlbarPrefs.clear("bestMatch.enabled");
});

// Tests the following:
// * click telemetry using mouse
// * best match
add_suggestions_task(async function click_mouse_bestMatch(suggestion) {
  UrlbarPrefs.set("bestMatch.enabled", true);
  await doClickTest({
    suggestion,
    improve_suggest_experience_checked:
      QuickSuggestTestUtils.DATA_COLLECTION_OFFLINE,
    isBestMatch: true,
  });
  UrlbarPrefs.clear("bestMatch.enabled");
});

async function doClickTest({
  improve_suggest_experience_checked,
  suggestion,
  useKeyboard,
  isBestMatch = false,
}) {
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    Services.telemetry.clearEvents();
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: suggestion.keywords[0],
      fireInputEvent: true,
    });

    let index = 1;
    let isSponsored = suggestion.keywords[0] == "sponsored";
    let result = await QuickSuggestTestUtils.assertIsQuickSuggest({
      window,
      index,
      isSponsored,
      isBestMatch,
      url: suggestion.url,
    });
    await UrlbarTestUtils.promisePopupClose(window, () => {
      if (useKeyboard) {
        EventUtils.synthesizeKey("KEY_ArrowDown");
        EventUtils.synthesizeKey("KEY_Enter");
      } else {
        EventUtils.synthesizeMouseAtCenter(result.element.row, {});
      }
    });

    let scalars = {
      [TELEMETRY_SCALARS.IMPRESSION]: index + 1,
      [TELEMETRY_SCALARS.CLICK]: index + 1,
    };
    if (isBestMatch) {
      if (isSponsored) {
        scalars = {
          ...scalars,
          [TELEMETRY_SCALARS.IMPRESSION_SPONSORED_BEST_MATCH]: index + 1,
          [TELEMETRY_SCALARS.CLICK_SPONSORED_BEST_MATCH]: index + 1,
        };
      } else {
        scalars = {
          ...scalars,
          [TELEMETRY_SCALARS.IMPRESSION_NONSPONSORED_BEST_MATCH]: index + 1,
          [TELEMETRY_SCALARS.CLICK_NONSPONSORED_BEST_MATCH]: index + 1,
        };
      }
    }
    QuickSuggestTestUtils.assertScalars(scalars);

    let match_type = isBestMatch ? "best-match" : "firefox-suggest";
    QuickSuggestTestUtils.assertEvents([
      {
        category: QuickSuggest.TELEMETRY_EVENT_CATEGORY,
        method: "engagement",
        object: "click",
        extra: {
          match_type,
          position: String(index + 1),
          suggestion_type: isSponsored ? "sponsored" : "nonsponsored",
        },
      },
    ]);
    QuickSuggestTestUtils.assertPings(spy, [
      {
        type: CONTEXTUAL_SERVICES_PING_TYPES.QS_IMPRESSION,
        payload: {
          improve_suggest_experience_checked,
          match_type,
          is_clicked: true,
          block_id: suggestion.id,
          position: index + 1,
        },
      },
      {
        type: CONTEXTUAL_SERVICES_PING_TYPES.QS_SELECTION,
        payload: {
          improve_suggest_experience_checked,
          match_type,
          block_id: suggestion.id,
          position: index + 1,
        },
      },
    ]);
  });

  await PlacesUtils.history.clear();

  await QuickSuggestTestUtils.setScenario(null);
  UrlbarPrefs.clear("quicksuggest.dataCollection.enabled");
  UrlbarPrefs.clear("suggest.quicksuggest.nonsponsored");
  UrlbarPrefs.clear("suggest.quicksuggest.sponsored");
}

// Tests impression and click telemetry by picking a quick suggest result when
// it's shown before search suggestions.
add_task(async function click_beforeSearchSuggestions() {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.showSearchSuggestionsFirst", false]],
  });
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    await withSuggestions(async () => {
      Services.telemetry.clearEvents();
      await UrlbarTestUtils.promiseAutocompleteResultPopup({
        window,
        value: "sponsored",
        fireInputEvent: true,
      });
      let resultCount = UrlbarTestUtils.getResultCount(window);
      Assert.equal(
        resultCount,
        4,
        "Result count == 1 heuristic + 1 quick suggest + 2 suggestions"
      );
      let index = resultCount - 3;
      await QuickSuggestTestUtils.assertIsQuickSuggest({
        window,
        index,
        url: SPONSORED_SUGGESTION.url,
      });
      await UrlbarTestUtils.promisePopupClose(window, () => {
        EventUtils.synthesizeKey("KEY_ArrowDown", { repeat: index });
        EventUtils.synthesizeKey("KEY_Enter");
      });
      // Arrow down to the quick suggest result and press Enter.
      QuickSuggestTestUtils.assertScalars({
        [TELEMETRY_SCALARS.IMPRESSION]: index + 1,
        [TELEMETRY_SCALARS.CLICK]: index + 1,
      });
      QuickSuggestTestUtils.assertEvents([
        {
          category: QuickSuggest.TELEMETRY_EVENT_CATEGORY,
          method: "engagement",
          object: "click",
          extra: {
            match_type: "firefox-suggest",
            position: String(index + 1),
            suggestion_type: "sponsored",
          },
        },
      ]);
      QuickSuggestTestUtils.assertPings(spy, [
        {
          type: CONTEXTUAL_SERVICES_PING_TYPES.QS_IMPRESSION,
          payload: {
            is_clicked: true,
            position: index + 1,
          },
        },
        {
          type: CONTEXTUAL_SERVICES_PING_TYPES.QS_SELECTION,
          payload: {
            position: index + 1,
          },
        },
      ]);
    });
  });
  await PlacesUtils.history.clear();
  await SpecialPowers.popPrefEnv();
});

// Tests the following:
// * help telemetry using keyboard
add_suggestions_task(async function help_keyboard(suggestion) {
  await doHelpTest({
    suggestion,
    useKeyboard: true,
  });
});

// Tests the following:
// * help telemetry using mouse
add_suggestions_task(async function help_mouse(suggestion) {
  await doHelpTest({
    suggestion,
    useKeyboard: false,
  });
});

// Tests the following:
// * help telemetry using keyboard
// * best match
add_suggestions_task(async function help_keyboard_bestMatch(suggestion) {
  UrlbarPrefs.set("bestMatch.enabled", true);
  await doHelpTest({
    suggestion,
    useKeyboard: true,
    isBestMatch: true,
  });
  UrlbarPrefs.clear("bestMatch.enabled");
});

// Tests the following:
// * help telemetry using mouse
// * best match
add_suggestions_task(async function help_mouse_bestMatch(suggestion) {
  UrlbarPrefs.set("bestMatch.enabled", true);
  await doHelpTest({
    suggestion,
    useKeyboard: false,
    isBestMatch: true,
  });
  UrlbarPrefs.clear("bestMatch.enabled");
});

async function doHelpTest({ suggestion, useKeyboard, isBestMatch = false }) {
  Services.telemetry.clearEvents();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: suggestion.keywords[0],
    fireInputEvent: true,
  });
  let index = 1;
  let isSponsored = suggestion.keywords[0] == "sponsored";
  let result = await QuickSuggestTestUtils.assertIsQuickSuggest({
    window,
    index,
    isSponsored,
    isBestMatch,
    url: suggestion.url,
  });

  let helpButton = result.element.row._buttons.get("help");
  Assert.ok(helpButton, "The result has a help button");
  let helpLoadPromise = BrowserTestUtils.waitForNewTab(gBrowser);
  await UrlbarTestUtils.promisePopupClose(window, () => {
    if (useKeyboard) {
      EventUtils.synthesizeKey("KEY_ArrowDown", { repeat: 2 });
      EventUtils.synthesizeKey("KEY_Enter");
    } else {
      EventUtils.synthesizeMouseAtCenter(helpButton, {});
    }
  });
  await helpLoadPromise;
  Assert.equal(
    gBrowser.currentURI.spec,
    QuickSuggest.HELP_URL,
    "Help URL loaded"
  );

  let scalars = {
    [TELEMETRY_SCALARS.IMPRESSION]: index + 1,
    [TELEMETRY_SCALARS.HELP]: index + 1,
  };
  if (isBestMatch) {
    if (isSponsored) {
      scalars = {
        ...scalars,
        [TELEMETRY_SCALARS.IMPRESSION_SPONSORED_BEST_MATCH]: index + 1,
        [TELEMETRY_SCALARS.HELP_SPONSORED_BEST_MATCH]: index + 1,
      };
    } else {
      scalars = {
        ...scalars,
        [TELEMETRY_SCALARS.IMPRESSION_NONSPONSORED_BEST_MATCH]: index + 1,
        [TELEMETRY_SCALARS.HELP_NONSPONSORED_BEST_MATCH]: index + 1,
      };
    }
  }
  QuickSuggestTestUtils.assertScalars(scalars);

  let match_type = isBestMatch ? "best-match" : "firefox-suggest";
  QuickSuggestTestUtils.assertEvents([
    {
      category: QuickSuggest.TELEMETRY_EVENT_CATEGORY,
      method: "engagement",
      object: "help",
      extra: {
        match_type,
        position: String(index + 1),
        suggestion_type: isSponsored ? "sponsored" : "nonsponsored",
      },
    },
  ]);
  QuickSuggestTestUtils.assertPings(spy, [
    {
      type: CONTEXTUAL_SERVICES_PING_TYPES.QS_IMPRESSION,
      payload: {
        match_type,
        block_id: suggestion.id,
        is_clicked: false,
        position: index + 1,
      },
    },
  ]);

  BrowserTestUtils.removeTab(gBrowser.selectedTab);
  await PlacesUtils.history.clear();
}

// Tests telemetry recorded when toggling the
// `suggest.quicksuggest.nonsponsored` pref:
// * contextservices.quicksuggest enable_toggled event telemetry
// * TelemetryEnvironment
add_task(async function enableToggled() {
  Services.telemetry.clearEvents();

  // Toggle the suggest.quicksuggest.nonsponsored pref twice. We should get two
  // events.
  let enabled = UrlbarPrefs.get("suggest.quicksuggest.nonsponsored");
  for (let i = 0; i < 2; i++) {
    enabled = !enabled;
    UrlbarPrefs.set("suggest.quicksuggest.nonsponsored", enabled);
    QuickSuggestTestUtils.assertEvents([
      {
        category: QuickSuggest.TELEMETRY_EVENT_CATEGORY,
        method: "enable_toggled",
        object: enabled ? "enabled" : "disabled",
      },
    ]);
    Assert.equal(
      TelemetryEnvironment.currentEnvironment.settings.userPrefs[
        "browser.urlbar.suggest.quicksuggest.nonsponsored"
      ],
      enabled,
      "suggest.quicksuggest.nonsponsored is correct in TelemetryEnvironment"
    );
  }

  // Set the main quicksuggest.enabled pref to false and toggle the
  // suggest.quicksuggest.nonsponsored pref again.  We shouldn't get any events.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.quicksuggest.enabled", false]],
  });
  enabled = !enabled;
  UrlbarPrefs.set("suggest.quicksuggest.nonsponsored", enabled);
  QuickSuggestTestUtils.assertEvents([]);
  await SpecialPowers.popPrefEnv();

  // Set the pref back to what it was at the start of the task.
  UrlbarPrefs.set("suggest.quicksuggest.nonsponsored", !enabled);
});

// Tests telemetry recorded when toggling the `suggest.quicksuggest.sponsored`
// pref:
// * contextservices.quicksuggest enable_toggled event telemetry
// * TelemetryEnvironment
add_task(async function sponsoredToggled() {
  Services.telemetry.clearEvents();

  // Toggle the suggest.quicksuggest.sponsored pref twice. We should get two
  // events.
  let enabled = UrlbarPrefs.get("suggest.quicksuggest.sponsored");
  for (let i = 0; i < 2; i++) {
    enabled = !enabled;
    UrlbarPrefs.set("suggest.quicksuggest.sponsored", enabled);
    QuickSuggestTestUtils.assertEvents([
      {
        category: QuickSuggest.TELEMETRY_EVENT_CATEGORY,
        method: "sponsored_toggled",
        object: enabled ? "enabled" : "disabled",
      },
    ]);
    Assert.equal(
      TelemetryEnvironment.currentEnvironment.settings.userPrefs[
        "browser.urlbar.suggest.quicksuggest.sponsored"
      ],
      enabled,
      "suggest.quicksuggest.sponsored is correct in TelemetryEnvironment"
    );
  }

  // Set the main quicksuggest.enabled pref to false and toggle the
  // suggest.quicksuggest.sponsored pref again. We shouldn't get any events.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.quicksuggest.enabled", false]],
  });
  enabled = !enabled;
  UrlbarPrefs.set("suggest.quicksuggest.sponsored", enabled);
  QuickSuggestTestUtils.assertEvents([]);
  await SpecialPowers.popPrefEnv();

  // Set the pref back to what it was at the start of the task.
  UrlbarPrefs.set("suggest.quicksuggest.sponsored", !enabled);
});

// Tests telemetry recorded when toggling the
// `quicksuggest.dataCollection.enabled` pref:
// * contextservices.quicksuggest data_collect_toggled event telemetry
// * TelemetryEnvironment
add_task(async function dataCollectionToggled() {
  Services.telemetry.clearEvents();

  // Toggle the quicksuggest.dataCollection.enabled pref twice. We should get
  // two events.
  let enabled = UrlbarPrefs.get("quicksuggest.dataCollection.enabled");
  for (let i = 0; i < 2; i++) {
    enabled = !enabled;
    UrlbarPrefs.set("quicksuggest.dataCollection.enabled", enabled);
    QuickSuggestTestUtils.assertEvents([
      {
        category: QuickSuggest.TELEMETRY_EVENT_CATEGORY,
        method: "data_collect_toggled",
        object: enabled ? "enabled" : "disabled",
      },
    ]);
    Assert.equal(
      TelemetryEnvironment.currentEnvironment.settings.userPrefs[
        "browser.urlbar.quicksuggest.dataCollection.enabled"
      ],
      enabled,
      "quicksuggest.dataCollection.enabled is correct in TelemetryEnvironment"
    );
  }

  // Set the main quicksuggest.enabled pref to false and toggle the data
  // collection pref again. We shouldn't get any events.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.quicksuggest.enabled", false]],
  });
  enabled = !enabled;
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", enabled);
  QuickSuggestTestUtils.assertEvents([]);
  await SpecialPowers.popPrefEnv();

  // Set the pref back to what it was at the start of the task.
  UrlbarPrefs.set("quicksuggest.dataCollection.enabled", !enabled);
});

// Tests telemetry recorded when clicking the checkbox for best match in
// preferences UI. The telemetry will be stored as following keyed scalar.
// scalar: browser.ui.interaction.preferences_panePrivacy
// key:    firefoxSuggestBestMatch
add_task(async function bestmatchCheckbox() {
  // Set the initial enabled status.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.bestMatch.enabled", true]],
  });

  // Open preferences page for best match.
  await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:preferences#privacy",
    true
  );

  for (let i = 0; i < 2; i++) {
    Services.telemetry.clearScalars();

    // Click on the checkbox.
    const doc = gBrowser.selectedBrowser.contentDocument;
    const checkboxId = "firefoxSuggestBestMatch";
    const checkbox = doc.getElementById(checkboxId);
    checkbox.scrollIntoView();
    await BrowserTestUtils.synthesizeMouseAtCenter(
      "#" + checkboxId,
      {},
      gBrowser.selectedBrowser
    );

    TelemetryTestUtils.assertKeyedScalar(
      TelemetryTestUtils.getProcessScalars("parent", true, true),
      "browser.ui.interaction.preferences_panePrivacy",
      checkboxId,
      1
    );
  }

  // Clean up.
  gBrowser.removeCurrentTab();
  await SpecialPowers.popPrefEnv();
});

// Tests telemetry recorded when opening the learn more link for best match in
// the preferences UI. The telemetry will be stored as following keyed scalar.
// scalar: browser.ui.interaction.preferences_panePrivacy
// key:    firefoxSuggestBestMatchLearnMore
add_task(async function bestmatchLearnMore() {
  // Set the initial enabled status.
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.bestMatch.enabled", true]],
  });

  // Open preferences page for best match.
  await BrowserTestUtils.openNewForegroundTab(
    gBrowser,
    "about:preferences#privacy",
    true
  );

  // Click on the learn more link.
  Services.telemetry.clearScalars();
  const learnMoreLinkId = "firefoxSuggestBestMatchLearnMore";
  const doc = gBrowser.selectedBrowser.contentDocument;
  const link = doc.getElementById(learnMoreLinkId);
  link.scrollIntoView();
  const onLearnMoreOpenedByClick = BrowserTestUtils.waitForNewTab(
    gBrowser,
    QuickSuggest.HELP_URL
  );
  await BrowserTestUtils.synthesizeMouseAtCenter(
    "#" + learnMoreLinkId,
    {},
    gBrowser.selectedBrowser
  );
  TelemetryTestUtils.assertKeyedScalar(
    TelemetryTestUtils.getProcessScalars("parent", true, true),
    "browser.ui.interaction.preferences_panePrivacy",
    "firefoxSuggestBestMatchLearnMore",
    1
  );
  await onLearnMoreOpenedByClick;
  gBrowser.removeCurrentTab();

  // Type enter key on the learm more link.
  Services.telemetry.clearScalars();
  link.focus();
  const onLearnMoreOpenedByKey = BrowserTestUtils.waitForNewTab(
    gBrowser,
    QuickSuggest.HELP_URL
  );
  await BrowserTestUtils.synthesizeKey(
    "KEY_Enter",
    {},
    gBrowser.selectedBrowser
  );
  TelemetryTestUtils.assertKeyedScalar(
    TelemetryTestUtils.getProcessScalars("parent", true, true),
    "browser.ui.interaction.preferences_panePrivacy",
    "firefoxSuggestBestMatchLearnMore",
    1
  );
  await onLearnMoreOpenedByKey;
  gBrowser.removeCurrentTab();

  // Clean up.
  gBrowser.removeCurrentTab();
  await SpecialPowers.popPrefEnv();
});

// Tests the Nimbus exposure event gets recorded after a quick suggest result
// impression.
add_task(async function nimbusExposure() {
  await QuickSuggestTestUtils.clearExposureEvent();

  await QuickSuggestTestUtils.withExperiment({
    valueOverrides: {
      quickSuggestEnabled: true,
      quickSuggestShouldShowOnboardingDialog: false,
    },
    callback: async () => {
      // No exposure event should be recorded after only enrolling.
      await QuickSuggestTestUtils.assertExposureEvent(false);

      // Do a search that doesn't trigger a quick suggest result. No exposure
      // event should be recorded.
      await UrlbarTestUtils.promiseAutocompleteResultPopup({
        window,
        value: "nimbusExposure no result",
        fireInputEvent: true,
      });
      await QuickSuggestTestUtils.assertNoQuickSuggestResults(window);
      await UrlbarTestUtils.promisePopupClose(window);
      QuickSuggestTestUtils.assertExposureEvent(false);

      // Do a search that does trigger a quick suggest result. The exposure
      // event should be recorded.
      await UrlbarTestUtils.promiseAutocompleteResultPopup({
        window,
        value: "sponsored",
        fireInputEvent: true,
      });
      await QuickSuggestTestUtils.assertIsQuickSuggest({
        window,
        index: 1,
        url: SPONSORED_SUGGESTION.url,
      });
      await QuickSuggestTestUtils.assertExposureEvent(true, "control");

      await UrlbarTestUtils.promisePopupClose(window);
    },
  });
});

// Simulates the race on startup between telemetry environment initialization
// and the initial update of the Suggest scenario. After startup is done,
// telemetry environment should record the correct values for startup prefs.
add_task(async function telemetryEnvironmentOnStartup() {
  await QuickSuggestTestUtils.setScenario(null);

  // Restart telemetry environment so we know it's watching its default set of
  // prefs.
  await TelemetryEnvironment.testCleanRestart().onInitialized();

  // Get the prefs that UrlbarPrefs sets when the Suggest scenario is updated on
  // startup. They're the union of the prefs exposed in the UI and the prefs
  // that are set on the default branch per scenario.
  let prefs = [
    ...new Set([
      ...Object.values(UrlbarPrefs.FIREFOX_SUGGEST_UI_PREFS_BY_VARIABLE),
      ...Object.values(UrlbarPrefs.FIREFOX_SUGGEST_DEFAULT_PREFS)
        .map(valuesByPrefName => Object.keys(valuesByPrefName))
        .flat(),
    ]),
  ];

  // Not all of the prefs are recorded in telemetry environment. Filter in the
  // ones that are.
  prefs = prefs.filter(
    p =>
      `browser.urlbar.${p}` in
      TelemetryEnvironment.currentEnvironment.settings.userPrefs
  );

  info("Got startup prefs: " + JSON.stringify(prefs));

  // Sanity check the expected prefs. This isn't strictly necessary since we
  // programmatically get the prefs above, but it's an extra layer of defense,
  // for example in case we accidentally filtered out some expected prefs above.
  // If this fails, you might have added a startup pref but didn't update this
  // array here.
  Assert.deepEqual(
    prefs.sort(),
    [
      "quicksuggest.dataCollection.enabled",
      "suggest.quicksuggest.nonsponsored",
      "suggest.quicksuggest.sponsored",
    ],
    "Expected startup prefs"
  );

  // Make sure the prefs don't have user values that would mask the default
  // values.
  for (let p of prefs) {
    UrlbarPrefs.clear(p);
  }

  // Build a map of default values.
  let defaultValues = Object.fromEntries(
    prefs.map(p => [p, UrlbarPrefs.get(p)])
  );

  // Now simulate startup. Restart telemetry environment but don't wait for it
  // to finish before calling `updateFirefoxSuggestScenario()`. This simulates
  // startup where telemetry environment's initialization races the intial
  // update of the Suggest scenario.
  let environmentInitPromise = TelemetryEnvironment.testCleanRestart().onInitialized();

  // Update the scenario and force the startup prefs to take on values that are
  // the inverse of what they are now.
  await UrlbarPrefs.updateFirefoxSuggestScenario({
    isStartup: true,
    scenario: "online",
    defaultPrefs: {
      online: Object.fromEntries(
        Object.entries(defaultValues).map(([p, value]) => [p, !value])
      ),
    },
  });

  // At this point telemetry environment should be done initializing since
  // `updateFirefoxSuggestScenario()` waits for it, but await our promise now.
  await environmentInitPromise;

  // TelemetryEnvironment should have cached the new values.
  for (let [p, value] of Object.entries(defaultValues)) {
    let expected = !value;
    Assert.strictEqual(
      TelemetryEnvironment.currentEnvironment.settings.userPrefs[
        `browser.urlbar.${p}`
      ],
      expected,
      `Check 1: ${p} is ${expected} in TelemetryEnvironment`
    );
  }

  // Simulate another startup and set all prefs back to their original default
  // values.
  environmentInitPromise = TelemetryEnvironment.testCleanRestart().onInitialized();

  await UrlbarPrefs.updateFirefoxSuggestScenario({
    isStartup: true,
    scenario: "online",
    defaultPrefs: {
      online: defaultValues,
    },
  });

  await environmentInitPromise;

  // TelemetryEnvironment should have cached the new (original) values.
  for (let [p, value] of Object.entries(defaultValues)) {
    let expected = value;
    Assert.strictEqual(
      TelemetryEnvironment.currentEnvironment.settings.userPrefs[
        `browser.urlbar.${p}`
      ],
      expected,
      `Check 2: ${p} is ${expected} in TelemetryEnvironment`
    );
  }

  await TelemetryEnvironment.testCleanRestart().onInitialized();
});

// When a quick suggest result is added to the view but hidden during the view
// update, impression telemetry should not be recorded for it.
add_task(async function impression_hiddenRow() {
  Services.telemetry.clearEvents();

  // Increase the timeout of the remove-stale-rows timer so that it doesn't
  // interfere with this task.
  let originalRemoveStaleRowsTimeout = UrlbarView.removeStaleRowsTimeout;
  UrlbarView.removeStaleRowsTimeout = 30000;
  registerCleanupFunction(() => {
    UrlbarView.removeStaleRowsTimeout = originalRemoveStaleRowsTimeout;
  });

  // Set up a test provider that doesn't add any results until we resolve its
  // `finishQueryPromise`. For the first search below, it will add many search
  // suggestions.
  let maxCount = UrlbarPrefs.get("maxRichResults");
  let results = [];
  for (let i = 0; i < maxCount; i++) {
    results.push(
      new UrlbarResult(
        UrlbarUtils.RESULT_TYPE.SEARCH,
        UrlbarUtils.RESULT_SOURCE.SEARCH,
        {
          engine: "Example",
          suggestion: "suggestion " + i,
          lowerCaseSuggestion: "suggestion " + i,
          query: "test",
        }
      )
    );
  }
  let provider = new DelayingTestProvider({ results });
  UrlbarProvidersManager.registerProvider(provider);

  // Open a new tab since we'll load a page below.
  let tab = await BrowserTestUtils.openNewForegroundTab({ gBrowser });

  // Do a normal search and allow the test provider to finish.
  provider.finishQueryPromise = Promise.resolve();
  await UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: "test",
    fireInputEvent: true,
  });

  // Sanity check the rows. After the heuristic, the remaining rows should be
  // the search results added by the test provider.
  Assert.equal(
    UrlbarTestUtils.getResultCount(window),
    maxCount,
    "Row count after first search"
  );
  for (let i = 1; i < maxCount; i++) {
    let result = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
    Assert.equal(
      result.type,
      UrlbarUtils.RESULT_TYPE.SEARCH,
      "Expected result type at index " + i
    );
    Assert.equal(
      result.source,
      UrlbarUtils.RESULT_SOURCE.SEARCH,
      "Expected result source at index " + i
    );
  }

  // Now set up a second search that triggers a quick suggest result. Add a
  // mutation listener to the view so we can tell when the quick suggest row is
  // added.
  let mutationPromise = new Promise(resolve => {
    let observer = new MutationObserver(mutations => {
      let rows = UrlbarTestUtils.getResultsContainer(window).children;
      for (let row of rows) {
        if (row.result.providerName == "UrlbarProviderQuickSuggest") {
          observer.disconnect();
          resolve(row);
          return;
        }
      }
    });
    observer.observe(UrlbarTestUtils.getResultsContainer(window), {
      childList: true,
    });
  });

  // Set the test provider's `finishQueryPromise` to a promise that doesn't
  // resolve. That will prevent the search from completing, which will prevent
  // the view from removing stale rows and showing the quick suggest row.
  let resolveQuery;
  provider.finishQueryPromise = new Promise(
    resolve => (resolveQuery = resolve)
  );

  // Start the second search but don't wait for it to finish.
  gURLBar.focus();
  let queryPromise = UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: SUGGESTIONS[0].keywords[0],
    fireInputEvent: true,
  });

  // Wait for the quick suggest row to be added to the view. It should be hidden
  // because (a) quick suggest results have a `suggestedIndex`, and rows with
  // suggested indexes can't replace rows without suggested indexes, and (b) the
  // view already contains the maximum number of rows due to the first search.
  // It should remain hidden until the search completes or the remove-stale-rows
  // timer fires. Next, we'll hit enter, which will cancel the search and close
  // the view, so the row should never appear.
  let quickSuggestRow = await mutationPromise;
  Assert.ok(
    BrowserTestUtils.is_hidden(quickSuggestRow),
    "Quick suggest row is hidden"
  );

  // Hit enter to pick the heuristic search result. This will cancel the search
  // and notify the quick suggest provider that an engagement occurred.
  let loadPromise = BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
  await UrlbarTestUtils.promisePopupClose(window, () => {
    EventUtils.synthesizeKey("KEY_Enter");
  });
  await loadPromise;

  // Resolve the test provider's promise finally.
  resolveQuery();
  await queryPromise;

  // The quick suggest provider added a result but it wasn't visible in the
  // view. No impression telemetry should be recorded for it.
  QuickSuggestTestUtils.assertScalars({});
  QuickSuggestTestUtils.assertEvents([]);
  QuickSuggestTestUtils.assertPings(spy, []);

  BrowserTestUtils.removeTab(tab);
  UrlbarProvidersManager.unregisterProvider(provider);
  UrlbarView.removeStaleRowsTimeout = originalRemoveStaleRowsTimeout;
});

// When a quick suggest result has not been added to the view, impression
// telemetry should not be recorded for it even if it's the result most recently
// returned by the provider.
add_task(async function impression_notAddedToView() {
  Services.telemetry.clearEvents();

  // Open a new tab since we'll load a page.
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    // Do an initial search that doesn't match any suggestions to make sure
    // there aren't any quick suggest results in the view to start.
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "this doesn't match anything",
      fireInputEvent: true,
    });
    await QuickSuggestTestUtils.assertNoQuickSuggestResults(window);
    await UrlbarTestUtils.promisePopupClose(window);

    // Now do a search for a suggestion and hit enter after the provider adds it
    // but before it appears in the view.
    await doEngagementWithoutAddingResultToView(SUGGESTIONS[0].keywords[0]);

    // The quick suggest provider added a result but it wasn't visible in the
    // view, and no other quick suggest results were visible in the view. No
    // impression telemetry should be recorded.
    QuickSuggestTestUtils.assertScalars({});
    QuickSuggestTestUtils.assertEvents([]);
    QuickSuggestTestUtils.assertPings(spy, []);
  });
});

// When a quick suggest result is visible in the view, impression telemetry
// should be recorded for it even if it's not the result most recently returned
// by the provider.
add_task(async function impression_previousResultStillVisible() {
  Services.telemetry.clearEvents();

  // Open a new tab since we'll load a page.
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    // Do a search for the first suggestion.
    let firstSuggestion = SUGGESTIONS[0];
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: firstSuggestion.keywords[0],
      fireInputEvent: true,
    });

    let index = 1;
    await QuickSuggestTestUtils.assertIsQuickSuggest({
      window,
      index,
      url: firstSuggestion.url,
    });

    // Without closing the view, do a second search for the second suggestion
    // and hit enter after the provider adds it but before it appears in the
    // view.
    await doEngagementWithoutAddingResultToView(
      SUGGESTIONS[1].keywords[0],
      index
    );

    // An impression for the first suggestion should be recorded since it's
    // still visible in the view, not the second suggestion.
    QuickSuggestTestUtils.assertScalars({
      [TELEMETRY_SCALARS.IMPRESSION]: index + 1,
    });
    QuickSuggestTestUtils.assertEvents([
      {
        category: QuickSuggest.TELEMETRY_EVENT_CATEGORY,
        method: "engagement",
        object: "impression_only",
        extra: {
          match_type: "firefox-suggest",
          position: String(index + 1),
          suggestion_type: "sponsored",
        },
      },
    ]);
    QuickSuggestTestUtils.assertPings(spy, [
      {
        type: CONTEXTUAL_SERVICES_PING_TYPES.QS_IMPRESSION,
        payload: {
          improve_suggest_experience_checked:
            QuickSuggestTestUtils.DATA_COLLECTION_OFFLINE,
          block_id: firstSuggestion.id,
          is_clicked: false,
          match_type: "firefox-suggest",
          position: index + 1,
        },
      },
    ]);
  });
});

/**
 * Does a search that causes the quick suggest provider to return a result
 * without adding it to the view and then hits enter to load a SERP and create
 * an engagement.
 *
 * @param {string} searchString
 *   The search string.
 * @param {number} previousResultIndex
 *   If the view is already open and showing a quick suggest result, pass its
 *   index here. Otherwise pass -1.
 */
async function doEngagementWithoutAddingResultToView(
  searchString,
  previousResultIndex = -1
) {
  // Set the timeout of the chunk timer to a really high value so that it will
  // not fire. The view updates when the timer fires, which we specifically want
  // to avoid here.
  let originalChunkDelayMs = UrlbarProvidersManager._chunkResultsDelayMs;
  UrlbarProvidersManager._chunkResultsDelayMs = 30000;
  registerCleanupFunction(() => {
    UrlbarProvidersManager._chunkResultsDelayMs = originalChunkDelayMs;
  });

  // Stub `UrlbarProviderQuickSuggest.getPriority()` to return Infinity.
  let sandbox = sinon.createSandbox();
  let getPriorityStub = sandbox.stub(UrlbarProviderQuickSuggest, "getPriority");
  getPriorityStub.returns(Infinity);

  // Spy on `UrlbarProviderQuickSuggest.onEngagement()`.
  let onEngagementSpy = sandbox.spy(UrlbarProviderQuickSuggest, "onEngagement");

  let sandboxCleanup = () => {
    getPriorityStub?.restore();
    getPriorityStub = null;
    sandbox?.restore();
    sandbox = null;
  };
  registerCleanupFunction(sandboxCleanup);

  // In addition to setting the chunk timeout to a large value above, in order
  // to prevent the view from updating there also needs to be a heuristic
  // provider that takes a long time to add results. Set one up that doesn't add
  // any results until we resolve its `finishQueryPromise`. Set its priority to
  // Infinity too so that only it and the quick suggest provider will be active.
  let provider = new DelayingTestProvider({
    results: [],
    priority: Infinity,
    type: UrlbarUtils.PROVIDER_TYPE.HEURISTIC,
  });
  UrlbarProvidersManager.registerProvider(provider);

  let resolveQuery;
  provider.finishQueryPromise = new Promise(r => (resolveQuery = r));

  // Add a query listener so we can grab the query context.
  let context;
  let queryListener = {
    onQueryStarted: c => (context = c),
  };
  gURLBar.controller.addQueryListener(queryListener);

  // Do a search but don't wait for it to finish.
  gURLBar.focus();
  UrlbarTestUtils.promiseAutocompleteResultPopup({
    window,
    value: searchString,
    fireInputEvent: true,
  });

  // Wait for the quick suggest provider to add its result to `context.results`.
  let result = await TestUtils.waitForCondition(
    () =>
      context?.results.find(
        r => r.providerName == "UrlbarProviderQuickSuggest"
      ),
    "Waiting for quick suggest result to be added to context.results"
  );

  gURLBar.controller.removeQueryListener(queryListener);

  // The view should not have updated, so the result's `rowIndex` should still
  // have its initial value of -1.
  Assert.equal(result.rowIndex, -1, "result.rowIndex is still -1");

  // If there's a result from the previous query, assert it's still in the
  // view. Otherwise assume that the view should be closed. These are mostly
  // sanity checks because they should only fail if the telemetry assertions
  // below also fail.
  if (previousResultIndex >= 0) {
    let rows = gURLBar.view.panel.querySelector(".urlbarView-results");
    Assert.equal(
      rows.children[previousResultIndex].result.providerName,
      "UrlbarProviderQuickSuggest",
      "Result already in view is a quick suggest"
    );
  } else {
    Assert.ok(!gURLBar.view.isOpen, "View is closed");
  }

  // Hit enter to load a SERP for the search string. This should notify the
  // quick suggest provider that an engagement occurred.
  let loadPromise = BrowserTestUtils.browserLoaded(gBrowser.selectedBrowser);
  await UrlbarTestUtils.promisePopupClose(window, () => {
    EventUtils.synthesizeKey("KEY_Enter");
  });
  await loadPromise;

  let engagementCalls = onEngagementSpy.getCalls().filter(call => {
    let state = call.args[1];
    return state == "engagement";
  });
  Assert.equal(engagementCalls.length, 1, "One engagement occurred");

  // Clean up.
  resolveQuery();
  UrlbarProvidersManager.unregisterProvider(provider);
  UrlbarProvidersManager._chunkResultsDelayMs = originalChunkDelayMs;
  sandboxCleanup();
}

/**
 * A test provider that doesn't finish `startQuery()` until `finishQueryPromise`
 * is resolved.
 */
class DelayingTestProvider extends UrlbarTestUtils.TestProvider {
  finishQueryPromise = null;
  async startQuery(context, addCallback) {
    for (let result of this._results) {
      addCallback(this, result);
    }
    await this.finishQueryPromise;
  }
}

/**
 * Adds a search engine that provides suggestions, calls your callback, and then
 * removes the engine.
 *
 * @param {Function} callback
 *   Your callback function.
 */
async function withSuggestions(callback) {
  await SpecialPowers.pushPrefEnv({
    set: [["browser.urlbar.suggest.searches", true]],
  });
  let engine = await SearchTestUtils.promiseNewSearchEngine({
    url: getRootDirectory(gTestPath) + "searchSuggestionEngine.xml",
  });
  let oldDefaultEngine = await Services.search.getDefault();
  await Services.search.setDefault(
    engine,
    Ci.nsISearchService.CHANGE_REASON_UNKNOWN
  );
  try {
    await callback(engine);
  } finally {
    await Services.search.setDefault(
      oldDefaultEngine,
      Ci.nsISearchService.CHANGE_REASON_UNKNOWN
    );
    await Services.search.removeEngine(engine);
    await SpecialPowers.popPrefEnv();
  }
}
