/* Any copyright is dedicated to the Public Domain.
 * http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

ChromeUtils.defineESModuleGetters(this, {
  ExtensionDNR: "resource://gre/modules/ExtensionDNR.sys.mjs",
  ExtensionDNRStore: "resource://gre/modules/ExtensionDNRStore.sys.mjs",
});

AddonTestUtils.init(this);
AddonTestUtils.overrideCertDB();

function backgroundWithDNRAPICallHandlers() {
  browser.test.onMessage.addListener(async (msg, ...args) => {
    let result;
    switch (msg) {
      case "getEnabledRulesets":
        result = await browser.declarativeNetRequest.getEnabledRulesets();
        break;
      case "getAvailableStaticRuleCount":
        result = await browser.declarativeNetRequest.getAvailableStaticRuleCount();
        break;
      case "testMatchOutcome":
        result = await browser.declarativeNetRequest
          .testMatchOutcome(...args)
          .catch(err =>
            browser.test.fail(
              `Unexpected rejection from testMatchOutcome call: ${err}`
            )
          );
        break;
      case "updateEnabledRulesets":
        // Run (one or more than one concurrently) updateEnabledRulesets calls
        // and report back the results.
        result = await Promise.all(
          args.map(arg => {
            return browser.declarativeNetRequest
              .updateEnabledRulesets(arg)
              .catch(err => {
                return { rejectedWithErrorMessage: err.message };
              });
          })
        );
        break;
      default:
        browser.test.fail(`Unexpected test message: ${msg}`);
        return;
    }

    browser.test.sendMessage(`${msg}:done`, result);
  });

  browser.test.sendMessage("bgpage:ready");
}

function getDNRRule({
  id = 1,
  priority = 1,
  action = {},
  condition = {},
} = {}) {
  return {
    id,
    priority,
    action: {
      type: "block",
      ...action,
    },
    condition: {
      ...condition,
    },
  };
}

function getDNRExtension({
  id = "test-dnr-static-rules@mochitest",
  version = "1.0",
  background = backgroundWithDNRAPICallHandlers,
  useAddonManager = "permanent",
  rule_resources,
  declarative_net_request,
  files,
}) {
  // Omit declarative_net_request if rule_resources isn't defined
  // (because declarative_net_request fails the manifest validation
  // if rule_resources is missing).
  const dnr = rule_resources ? { rule_resources } : undefined;

  return {
    background,
    useAddonManager,
    manifest: {
      manifest_version: 3,
      version,
      permissions: ["declarativeNetRequest", "declarativeNetRequestFeedback"],
      // Needed to make sure the upgraded extension will have the same id and
      // same uuid (which is mapped based on the extension id).
      browser_specific_settings: {
        gecko: { id },
      },
      declarative_net_request: declarative_net_request
        ? { ...declarative_net_request, ...(dnr ?? {}) }
        : dnr,
    },
    files,
  };
}

const getSchemaNormalizedRule = (extensionTestWrapper, value) => {
  const { extension } = extensionTestWrapper;
  const validationContext = {
    url: extension.baseURI.spec,
    principal: extension.principal,
    logError: err => {
      // We don't expect this test helper function to be called on invalid rules,
      // and so we trigger an explicit test failure if we ever hit any.
      Assert.ok(
        false,
        `Unexpected logError on normalizing DNR rule ${JSON.stringify(
          value
        )} - ${err}`
      );
    },
    preprocessors: {},
    manifestVersion: extension.manifestVersion,
  };

  return Schemas.normalize(
    value,
    "declarativeNetRequest.Rule",
    validationContext
  );
};

const getSchemaNormalizedRules = (extensionTestWrapper, rules) => {
  return rules.map(rule => {
    const normalized = getSchemaNormalizedRule(extensionTestWrapper, rule);
    if (normalized.error) {
      throw new Error(
        `Unexpected DNR Rule normalization error: ${normalized.error}`
      );
    }
    return normalized.value;
  });
};

const assertDNRTestMatchOutcome = async (
  { extension, testRequest, expected },
  assertMessage
) => {
  extension.sendMessage("testMatchOutcome", testRequest);
  Assert.deepEqual(
    expected,
    await extension.awaitMessage("testMatchOutcome:done"),
    assertMessage ??
      "Got the expected matched rules from testMatchOutcome API call"
  );
};

const assertDNRGetAvailableStaticRuleCount = async (
  extensionTestWrapper,
  expectedCount,
  assertMessage
) => {
  extensionTestWrapper.sendMessage("getAvailableStaticRuleCount");
  Assert.deepEqual(
    await extensionTestWrapper.awaitMessage("getAvailableStaticRuleCount:done"),
    expectedCount,
    assertMessage ??
      "Got the expected count value from dnr.getAvailableStaticRuleCount API method"
  );
};

const assertDNRGetEnabledRulesets = async (
  extensionTestWrapper,
  expectedRulesetIds
) => {
  extensionTestWrapper.sendMessage("getEnabledRulesets");
  Assert.deepEqual(
    await extensionTestWrapper.awaitMessage("getEnabledRulesets:done"),
    expectedRulesetIds,
    "Got the expected enabled ruleset ids from dnr.getEnabledRulesets API method"
  );
};

const assertDNRStoreData = async (
  dnrStore,
  extensionTestWrapper,
  expectedRulesets,
  { assertIndividualRules = true } = {}
) => {
  const extUUID = extensionTestWrapper.uuid;
  const rule_resources =
    extensionTestWrapper.extension.manifest.declarative_net_request
      ?.rule_resources;
  const expectedRulesetIds = Array.from(Object.keys(expectedRulesets));
  const expectedRulesetIndexesMap = expectedRulesetIds.reduce((acc, rsId) => {
    acc.set(
      rsId,
      rule_resources.findIndex(rr => rr.id === rsId)
    );
    return acc;
  }, new Map());

  ok(
    dnrStore._dataPromises.has(extUUID),
    "Got promise for the test extension DNR data being loaded"
  );

  await dnrStore._dataPromises.get(extUUID);

  ok(dnrStore._data.has(extUUID), "Got data for the test extension");

  const dnrExtData = dnrStore._data.get(extUUID);
  Assert.deepEqual(
    {
      schemaVersion: dnrExtData.schemaVersion,
      extVersion: dnrExtData.extVersion,
    },
    {
      schemaVersion: dnrExtData.constructor.VERSION,
      extVersion: extensionTestWrapper.extension.version,
    },
    "Got the expected data schema version and extension version in the store data"
  );
  Assert.deepEqual(
    Array.from(dnrExtData.staticRulesets.keys()),
    expectedRulesetIds,
    "Got the enabled rulesets in the stored data staticRulesets Map"
  );

  for (const rulesetId of expectedRulesetIds) {
    const expectedRulesetIdx = expectedRulesetIndexesMap.get(rulesetId);
    const expectedRulesetRules = getSchemaNormalizedRules(
      extensionTestWrapper,
      expectedRulesets[rulesetId]
    );
    const actualData = dnrExtData.staticRulesets.get(rulesetId);
    equal(
      actualData.idx,
      expectedRulesetIdx,
      `Got the expected ruleset index for ruleset id ${rulesetId}`
    );

    // Asserting an entire array of rules all at once will produce
    // a big enough output to don't be immediately useful to investigate
    // failures, asserting each rule individually would produce more
    // readable assertion failure logs.
    const assertRuleAtIdx = ruleIdx =>
      Assert.deepEqual(
        actualData.rules[ruleIdx],
        expectedRulesetRules[ruleIdx],
        `Got the expected rule at index ${ruleIdx} for ruleset id "${rulesetId}"`
      );

    // Some tests may be using a big enough number of rules that
    // the assertiongs would be producing a huge amount of log spam,
    // and so for those tests we only explicitly assert the first
    // and last rule and that the total amount of rules matches the
    // expected number of rules (there are still other tests explicitly
    // asserting all loaded rules).
    if (assertIndividualRules) {
      info(
        `Verify the each individual rule loaded for ruleset id "${rulesetId}"`
      );
      for (let ruleIdx = 0; ruleIdx < expectedRulesetRules.length; ruleIdx++) {
        assertRuleAtIdx(ruleIdx);
      }
    } else {
      // NOTE: Only asserting the first and last rule also helps to speed up
      // the test is some slower builds when the number of expected rules is
      // big enough (e.g. the test task verifying the enforced rule count limits
      // was timing out in tsan build because asserting all indidual rules was
      // taking long enough and the event page was being suspended on the idle
      // timeout by the time we did run all these assertion and proceeding with
      // the rest of the test task assertions), we still confirm that the total
      // number of expected vs actual rules also matches right after these
      // assertions.
      info(
        `Verify the first and last rules loaded for ruleset id "${rulesetId}"`
      );
      const lastExpectedRuleIdx = expectedRulesetRules.length - 1;
      for (const ruleIdx of [0, lastExpectedRuleIdx]) {
        assertRuleAtIdx(ruleIdx);
      }
    }

    equal(
      actualData.rules.length,
      expectedRulesetRules.length,
      `Got the expected number of rules loaded for ruleset id "${rulesetId}"`
    );
  }
};

add_setup(async () => {
  Services.prefs.setBoolPref("extensions.manifestV3.enabled", true);
  Services.prefs.setBoolPref("extensions.dnr.enabled", true);
  Services.prefs.setBoolPref("extensions.dnr.feedback", true);

  await ExtensionTestUtils.startAddonManager();
});

add_task(async function test_load_static_rules() {
  const ruleset1Data = [
    getDNRRule({
      action: { type: "allow" },
      condition: { resourceTypes: ["main_frame"] },
    }),
  ];
  const ruleset2Data = [
    getDNRRule({
      action: { type: "block" },
      condition: { resourceTypes: ["main_frame", "script"] },
    }),
  ];

  const rule_resources = [
    {
      id: "ruleset_1",
      enabled: true,
      path: "ruleset_1.json",
    },
    {
      id: "ruleset_2",
      enabled: true,
      path: "ruleset_2.json",
    },
    {
      id: "ruleset_3",
      enabled: false,
      path: "ruleset_3.json",
    },
  ];
  const files = {
    // Missing ruleset_3.json on purpose.
    "ruleset_1.json": JSON.stringify(ruleset1Data),
    "ruleset_2.json": JSON.stringify(ruleset2Data),
  };

  const extension = ExtensionTestUtils.loadExtension(
    getDNRExtension({ rule_resources, files })
  );

  await extension.startup();

  const extUUID = extension.uuid;

  await extension.awaitMessage("bgpage:ready");

  const dnrStore = ExtensionDNRStore._getStoreForTesting();

  info("Verify DNRStore data for the test extension");
  await assertDNRGetEnabledRulesets(extension, ["ruleset_1", "ruleset_2"]);

  await assertDNRStoreData(dnrStore, extension, {
    ruleset_1: getSchemaNormalizedRules(extension, ruleset1Data),
    ruleset_2: getSchemaNormalizedRules(extension, ruleset2Data),
  });

  info("Verify matched rules using testMatchOutcome");
  const testRequestMainFrame = {
    url: "https://example.com/some-dummy-url",
    type: "main_frame",
  };
  const testRequestScript = {
    url: "https://example.com/some-dummy-url.js",
    type: "script",
  };

  await assertDNRTestMatchOutcome(
    {
      extension,
      testRequest: testRequestMainFrame,
      expected: {
        matchedRules: [{ ruleId: 1, rulesetId: "ruleset_1" }],
      },
    },
    "Expect ruleset_1 to be matched on the main-frame test request"
  );
  await assertDNRTestMatchOutcome(
    {
      extension,
      testRequest: testRequestScript,
      expected: {
        matchedRules: [{ ruleId: 1, rulesetId: "ruleset_2" }],
      },
    },
    "Expect ruleset_2 to be matched on the script test request"
  );

  info("Verify DNRStore data persisted on disk for the test extension");
  // The data will not be stored on disk until something is being changed
  // from what was already available in the manifest and so in this
  // test we save manually (a test for the updateEnabledRulesets will
  // take care of asserting that the data has been stored automatically
  // on disk when it is meant to).
  await dnrStore.save(extension.extension);

  const { storeFile } = dnrStore.getFilePaths(extUUID);

  ok(await IOUtils.exists(storeFile), `DNR storeFile ${storeFile} found`);

  // force deleting the data stored in memory to confirm if it being loaded again from
  // the files stored on disk.
  dnrStore._data.delete(extUUID);
  dnrStore._dataPromises.delete(extUUID);

  info("Verify the expected DNRStore data persisted on disk is loaded back");
  const { AddonManager } = ChromeUtils.import(
    "resource://gre/modules/AddonManager.jsm"
  );
  const addon = await AddonManager.getAddonByID(extension.id);
  await addon.disable();

  ok(
    !dnrStore._dataPromises.has(extUUID),
    "DNR store read data promise cleared after the extension has been disabled"
  );
  ok(
    !dnrStore._data.has(extUUID),
    "DNR store data cleared from memory after the extension has been disabled"
  );

  await addon.enable();
  await extension.awaitMessage("bgpage:ready");
  await assertDNRGetEnabledRulesets(extension, ["ruleset_1", "ruleset_2"]);

  await assertDNRStoreData(dnrStore, extension, {
    ruleset_1: getSchemaNormalizedRules(extension, ruleset1Data),
    ruleset_2: getSchemaNormalizedRules(extension, ruleset2Data),
  });

  info("Verify matched rules using testMatchOutcome");
  await assertDNRTestMatchOutcome(
    {
      extension,
      testRequest: testRequestMainFrame,
      expected: {
        matchedRules: [{ ruleId: 1, rulesetId: "ruleset_1" }],
      },
    },
    "Expect ruleset_1 to be matched on the main-frame test request"
  );

  info("Verify enabled static rules updated on addon updates");
  await extension.upgrade(
    getDNRExtension({
      version: "2.0",
      rule_resources: [
        {
          id: "ruleset_1",
          enabled: false,
          path: "ruleset_1.json",
        },
        {
          id: "ruleset_2",
          enabled: true,
          path: "ruleset_2.json",
        },
      ],
      files: {
        "ruleset_2.json": JSON.stringify(ruleset2Data),
      },
    })
  );
  await extension.awaitMessage("bgpage:ready");
  await assertDNRGetEnabledRulesets(extension, ["ruleset_2"]);
  await assertDNRStoreData(dnrStore, extension, {
    ruleset_2: getSchemaNormalizedRules(extension, ruleset2Data),
  });

  info("Verify matched rules using testMatchOutcome");
  await assertDNRTestMatchOutcome(
    {
      extension,
      testRequest: testRequestMainFrame,
      expected: {
        matchedRules: [{ ruleId: 1, rulesetId: "ruleset_2" }],
      },
    },
    "Expect ruleset_2 to be matched on the main-frame test request"
  );

  info(
    "Verify enabled static rules updated on addon updates even if version in the manifest did not change"
  );
  await extension.upgrade(
    getDNRExtension({
      rule_resources: [
        {
          id: "ruleset_1",
          enabled: true,
          path: "ruleset_1.json",
        },
        {
          id: "ruleset_2",
          enabled: false,
          path: "ruleset_2.json",
        },
      ],
      files: {
        "ruleset_1.json": JSON.stringify(ruleset1Data),
      },
    })
  );
  await extension.awaitMessage("bgpage:ready");
  await assertDNRGetEnabledRulesets(extension, ["ruleset_1"]);
  await assertDNRStoreData(dnrStore, extension, {
    ruleset_1: getSchemaNormalizedRules(extension, ruleset1Data),
  });

  info("Verify matched rules using testMatchOutcome");
  await assertDNRTestMatchOutcome(
    {
      extension,
      testRequest: testRequestMainFrame,
      expected: {
        matchedRules: [{ ruleId: 1, rulesetId: "ruleset_1" }],
      },
    },
    "Expect ruleset_2 to be matched on the main-script test request"
  );

  info(
    "Verify updated addon version with no static rules but declarativeNetRequest permission granted"
  );
  await extension.upgrade(
    getDNRExtension({
      version: "3.0",
      rule_resources: undefined,
      files: {},
    })
  );
  await extension.awaitMessage("bgpage:ready");
  await assertDNRGetEnabledRulesets(extension, []);
  await assertDNRStoreData(dnrStore, extension, {});

  info("Verify matched rules using testMatchOutcome");
  await assertDNRTestMatchOutcome(
    {
      extension,
      testRequest: testRequestScript,
      expected: {
        matchedRules: [],
      },
    },
    "Expect no match on the script test request on test extension without no static rules"
  );

  info("Verify store file removed on addon uninstall");
  await extension.unload();

  ok(
    !dnrStore._dataPromises.has(extUUID),
    "DNR store read data promise cleared after the extension has been unloaded"
  );
  ok(
    !dnrStore._data.has(extUUID),
    "DNR store data cleared from memory after the extension has been unloaded"
  );

  ok(
    !(await IOUtils.exists(storeFile)),
    `DNR storeFile ${storeFile} removed on addon uninstalled`
  );
});

add_task(async function test_ruleset_validation() {
  const invalidRulesetIdCases = [
    {
      description: "empty ruleset id",
      rule_resources: [
        {
          // Invalid empty ruleset id.
          id: "",
          path: "ruleset_0.json",
          enabled: true,
        },
      ],
      expected: [
        // Validation error emitted from the manifest schema validation.
        {
          message: /rule_resources\.0\.id: String "" must match/,
        },
      ],
    },
    {
      description: "invalid ruleset id starting with '_'",
      rule_resources: [
        {
          // Invalid empty ruleset id.
          id: "_invalid_ruleset_id",
          path: "ruleset_0.json",
          enabled: true,
        },
      ],
      expected: [
        // Validation error emitted from the manifest schema validation.
        {
          message: /rule_resources\.0\.id: String "_invalid_ruleset_id" must match/,
        },
      ],
    },
    {
      description: "duplicated ruleset ids",
      rule_resources: [
        {
          id: "ruleset_2",
          path: "ruleset_2.json",
          enabled: true,
        },
        {
          // Duplicated ruleset id.
          id: "ruleset_2",
          path: "duplicated_ruleset_2.json",
          enabled: true,
        },
        {
          id: "ruleset_3",
          path: "ruleset_3.json",
          enabled: true,
        },
        {
          // Other duplicated ruleset id.
          id: "ruleset_3",
          path: "duplicated_ruleset_3.json",
          enabled: true,
        },
      ],
      // NOTE: this is currently a warning logged from onManifestEntry, and so it would actually
      // fail in test harness due to the manifest warning, because it is too late at that point
      // the addon is technically already starting at that point.
      expectInstallFailed: false,
      expected: [
        {
          message: /declarative_net_request: Static ruleset ids should be unique.*: "ruleset_2" at index 1, "ruleset_3" at index 3/,
        },
      ],
    },
    {
      description: "missing mandatory path",
      rule_resources: [
        {
          // Missing mandatory path.
          id: "ruleset_3",
          enabled: true,
        },
      ],
      expected: [
        {
          message: /rule_resources\.0: Property "path" is required/,
        },
      ],
    },
    {
      description: "missing mandatory id",
      rule_resources: [
        {
          // Missing mandatory id.
          enabled: true,
          path: "missing_ruleset_id.json",
        },
      ],
      expected: [
        {
          message: /rule_resources\.0: Property "id" is required/,
        },
      ],
    },
    {
      description: "duplicated ruleset path",
      rule_resources: [
        {
          id: "ruleset_2",
          path: "ruleset_2.json",
          enabled: true,
        },
        {
          // Duplicate path.
          id: "ruleset_3",
          path: "ruleset_2.json",
          enabled: true,
        },
      ],
      // NOTE: we couldn't get on agreement about making this a manifest validation error, apparently Chrome doesn't validate it and doesn't
      // even report any warning, and so it is logged only as an informative warning but without triggering an install failure.
      expectInstallFailed: false,
      expected: [
        {
          message: /declarative_net_request: Static rulesets paths are not unique.*: ".*ruleset_2.json" at index 1/,
        },
      ],
    },
    {
      description: "missing mandatory enabled",
      rule_resources: [
        {
          id: "ruleset_without_enabled",
          path: "ruleset.json",
        },
      ],
      expected: [
        {
          message: /rule_resources\.0: Property "enabled" is required/,
        },
      ],
    },
    {
      description: "allows and warns additional properties",
      declarative_net_request: {
        unexpected_prop: true,
        rule_resources: [
          {
            id: "ruleset1",
            path: "ruleset1.json",
            enabled: false,
            unexpected_prop: true,
          },
        ],
      },
      expectInstallFailed: false,
      expected: [
        {
          message: /declarative_net_request.unexpected_prop: An unexpected property was found/,
        },
        {
          message: /rule_resources.0.unexpected_prop: An unexpected property was found/,
        },
      ],
    },
  ];

  for (const {
    description,
    declarative_net_request,
    rule_resources,
    expected,
    expectInstallFailed = true,
  } of invalidRulesetIdCases) {
    info(`Test manifest validation: ${description}`);
    let extension = ExtensionTestUtils.loadExtension(
      getDNRExtension({ rule_resources, declarative_net_request })
    );

    const { messages } = await AddonTestUtils.promiseConsoleOutput(async () => {
      ExtensionTestUtils.failOnSchemaWarnings(false);
      if (expectInstallFailed) {
        await Assert.rejects(
          extension.startup(),
          /Install failed/,
          "Expected install to fail"
        );
      } else {
        await extension.startup();
        await extension.awaitMessage("bgpage:ready");
        await extension.unload();
      }
      ExtensionTestUtils.failOnSchemaWarnings(true);
    });

    AddonTestUtils.checkMessages(messages, { expected });
  }
});

add_task(async function test_updateEnabledRuleset_id_validation() {
  const rule_resources = [
    {
      id: "ruleset_1",
      enabled: true,
      path: "ruleset_1.json",
    },
    {
      id: "ruleset_2",
      enabled: false,
      path: "ruleset_2.json",
    },
  ];

  const ruleset1Data = [
    getDNRRule({
      action: { type: "allow" },
      condition: { resourceTypes: ["main_frame"] },
    }),
  ];
  const ruleset2Data = [
    getDNRRule({
      action: { type: "block" },
      condition: { resourceTypes: ["main_frame", "script"] },
    }),
  ];

  const files = {
    "ruleset_1.json": JSON.stringify(ruleset1Data),
    "ruleset_2.json": JSON.stringify(ruleset2Data),
  };

  let extension = ExtensionTestUtils.loadExtension(
    getDNRExtension({ rule_resources, files })
  );

  await extension.startup();
  await extension.awaitMessage("bgpage:ready");

  await assertDNRGetEnabledRulesets(extension, ["ruleset_1"]);

  const dnrStore = ExtensionDNRStore._getStoreForTesting();
  await assertDNRStoreData(dnrStore, extension, {
    ruleset_1: getSchemaNormalizedRules(extension, ruleset1Data),
  });

  const invalidStaticRulesetIds = [
    // The following two are reserved for session and dynamic rules.
    "_session",
    "_dynamic",
    "ruleset_non_existing",
  ];

  for (const invalidRSId of invalidStaticRulesetIds) {
    extension.sendMessage(
      "updateEnabledRulesets",
      // Only in rulesets to be disabled.
      { disableRulesetIds: [invalidRSId] },
      // Only in rulesets to be enabled.
      { enableRulesetIds: [invalidRSId] },
      // In both rulesets to be enabled and disabled.
      { disableRulesetIds: [invalidRSId], enableRulesetIds: [invalidRSId] },
      // Along with existing rulesets (and expected the existing rulesets
      // to stay unchanged due to the invalid ruleset ids.)
      {
        disableRulesetIds: [invalidRSId, "ruleset_1"],
        enableRulesetIds: [invalidRSId, "ruleset_2"],
      }
    );
    const [
      resInDisable,
      resInEnable,
      resInEnableAndDisable,
      resInSameRequestAsValid,
    ] = await extension.awaitMessage("updateEnabledRulesets:done");
    await Assert.rejects(
      Promise.reject(resInDisable?.rejectedWithErrorMessage),
      new RegExp(`Invalid ruleset id: "${invalidRSId}"`),
      `Got the expected rejection on invalid ruleset id "${invalidRSId}" in disableRulesetIds`
    );
    await Assert.rejects(
      Promise.reject(resInEnable?.rejectedWithErrorMessage),
      new RegExp(`Invalid ruleset id: "${invalidRSId}"`),
      `Got the expected rejection on invalid ruleset id "${invalidRSId}" in enableRulesetIds`
    );
    await Assert.rejects(
      Promise.reject(resInEnableAndDisable?.rejectedWithErrorMessage),
      new RegExp(`Invalid ruleset id: "${invalidRSId}"`),
      `Got the expected rejection on invalid ruleset id "${invalidRSId}" in both enable/disableRulesetIds`
    );
    await Assert.rejects(
      Promise.reject(resInSameRequestAsValid?.rejectedWithErrorMessage),
      new RegExp(`Invalid ruleset id: "${invalidRSId}"`),
      `Got the expected rejection on invalid ruleset id "${invalidRSId}" along with valid ruleset ids`
    );
  }

  // Confirm that the expected rulesets didn't change neither.
  await assertDNRGetEnabledRulesets(extension, ["ruleset_1"]);
  await assertDNRStoreData(dnrStore, extension, {
    ruleset_1: getSchemaNormalizedRules(extension, ruleset1Data),
  });

  // - List the same ruleset ids more than ones is expected to work and
  //   to be resulting in the same set of rules being enabled
  // - Disabling and Enabling the same ruleset id should result in the
  //   ruleset being enabled.
  await extension.sendMessage("updateEnabledRulesets", {
    disableRulesetIds: [
      "ruleset_1",
      "ruleset_1",
      "ruleset_2",
      "ruleset_2",
      "ruleset_2",
    ],
    enableRulesetIds: ["ruleset_2", "ruleset_2"],
  });
  Assert.deepEqual(
    await extension.awaitMessage("updateEnabledRulesets:done"),
    [undefined],
    "Expect the updateEnabledRulesets to result successfully"
  );

  await assertDNRGetEnabledRulesets(extension, ["ruleset_2"]);
  await assertDNRStoreData(dnrStore, extension, {
    ruleset_2: getSchemaNormalizedRules(extension, ruleset2Data),
  });

  await extension.unload();
});

add_task(async function test_getAvailableStaticRulesCountAndLimits() {
  const dnrStore = ExtensionDNRStore._getStoreForTesting();
  const { GUARANTEED_MINIMUM_STATIC_RULES } = ExtensionDNR.limits;
  equal(
    typeof GUARANTEED_MINIMUM_STATIC_RULES,
    "number",
    "Expect GUARANTEED_MINIMUM_STATIC_RULES to be a number"
  );

  const availableStaticRulesCount = GUARANTEED_MINIMUM_STATIC_RULES;

  const rule_resources = [
    {
      id: "ruleset_0",
      path: "/ruleset_0.json",
      enabled: true,
    },
    {
      id: "ruleset_1",
      path: "/ruleset_1.json",
      enabled: true,
    },
    // A ruleset initially disabled (to make sure it doesn't count for the
    // rules count limit).
    {
      id: "ruleset_disabled",
      path: "/ruleset_disabled.json",
      enabled: false,
    },
    // A ruleset including an invalid rule and valid rule.
    {
      id: "ruleset_withInvalid",
      path: "/ruleset_withInvalid.json",
      enabled: false,
    },
    // An empty ruleset (to make sure it can still be enabled/disabled just fine,
    // e.g. in case on some browser version all rules are technically invalid).
    {
      id: "ruleset_empty",
      path: "/ruleset_empty.json",
      enabled: false,
    },
  ];

  const files = {};
  const rules = {};

  const rulesetDisabledData = [getDNRRule({ id: 1 })];
  const ruleValid = getDNRRule({ id: 2, action: { type: "allow" } });
  const rulesetWithInvalidData = [
    getDNRRule({ id: 1, action: { type: "invalid_action" } }),
    ruleValid,
  ];

  rules.ruleset_0 = [getDNRRule({ id: 1 }), getDNRRule({ id: 2 })];

  rules.ruleset_1 = [];
  for (let i = 0; i < availableStaticRulesCount; i++) {
    rules.ruleset_1.push(getDNRRule({ id: i + 1 }));
  }

  for (const [k, v] of Object.entries(rules)) {
    files[`${k}.json`] = JSON.stringify(v);
  }
  files[`ruleset_disabled.json`] = JSON.stringify(rulesetDisabledData);
  files[`ruleset_withInvalid.json`] = JSON.stringify(rulesetWithInvalidData);
  files[`ruleset_empty.json`] = JSON.stringify([]);

  const extension = ExtensionTestUtils.loadExtension(
    getDNRExtension({
      id: "dnr-getAvailable-count-@mochitest",
      rule_resources,
      files,
    })
  );

  await extension.startup();
  await extension.awaitMessage("bgpage:ready");

  const expectedEnabledRulesets = {};
  expectedEnabledRulesets.ruleset_0 = getSchemaNormalizedRules(
    extension,
    rules.ruleset_0
  );

  info(
    "Expect ruleset_1 to not be enabled because along with ruleset_0 exceeded the static rules count limit"
  );
  await assertDNRStoreData(dnrStore, extension, expectedEnabledRulesets);

  await assertDNRGetAvailableStaticRuleCount(
    extension,
    availableStaticRulesCount - rules.ruleset_0.length,
    "Got the available static rule count on ruleset_0 initially enabled"
  );

  // Try to enable ruleset_1 again from the API method.
  extension.sendMessage("updateEnabledRulesets", {
    enableRulesetIds: ["ruleset_1"],
  });
  await extension.awaitMessage("updateEnabledRulesets:done");

  info(
    "Expect ruleset_1 to not be enabled because still exceeded the static rules count limit"
  );
  await assertDNRGetEnabledRulesets(extension, ["ruleset_0"]);
  await assertDNRStoreData(dnrStore, extension, expectedEnabledRulesets);

  await assertDNRGetAvailableStaticRuleCount(
    extension,
    availableStaticRulesCount - rules.ruleset_0.length,
    "Got the available static rule count on ruleset_0 still the only one enabled"
  );

  extension.sendMessage("updateEnabledRulesets", {
    disableRulesetIds: ["ruleset_0"],
    enableRulesetIds: ["ruleset_1"],
  });
  await extension.awaitMessage("updateEnabledRulesets:done");

  info("Expect ruleset_1 to be enabled along with disabling ruleset_0");
  await assertDNRGetEnabledRulesets(extension, ["ruleset_1"]);
  delete expectedEnabledRulesets.ruleset_0;
  expectedEnabledRulesets.ruleset_1 = getSchemaNormalizedRules(
    extension,
    rules.ruleset_1
  );
  await assertDNRStoreData(dnrStore, extension, expectedEnabledRulesets, {
    // Assert total amount of expected rules and only the first and last rule
    // individually, to avoid generating a huge amount of logs and potential
    // timeout failures on slower builds.
    assertIndividualRules: false,
  });

  await assertDNRGetAvailableStaticRuleCount(
    extension,
    0,
    "Expect no additional static rules count available when ruleset_1 is enabled"
  );

  info(
    "Expect ruleset_disabled to stay disabled because along with ruleset_1 exceeeds the limits"
  );
  extension.sendMessage("updateEnabledRulesets", {
    enableRulesetIds: ["ruleset_disabled"],
  });
  await extension.awaitMessage("updateEnabledRulesets:done");
  await assertDNRGetEnabledRulesets(extension, ["ruleset_1"]);
  await assertDNRStoreData(dnrStore, extension, expectedEnabledRulesets, {
    // Assert total amount of expected rules and only the first and last rule
    // individually, to avoid generating a huge amount of logs and potential
    // timeout failures on slower builds.
    assertIndividualRules: false,
  });
  await assertDNRGetAvailableStaticRuleCount(
    extension,
    0,
    "Expect no additional static rules count available"
  );

  info("Expect ruleset_empty to be enabled despite having reached the limit");
  extension.sendMessage("updateEnabledRulesets", {
    enableRulesetIds: ["ruleset_empty"],
  });
  await extension.awaitMessage("updateEnabledRulesets:done");
  await assertDNRGetEnabledRulesets(extension, ["ruleset_1", "ruleset_empty"]);
  await assertDNRStoreData(
    dnrStore,
    extension,
    {
      ...expectedEnabledRulesets,
      ruleset_empty: [],
    },
    // Assert total amount of expected rules and only the first and last rule
    // individually, to avoid generating a huge amount of logs and potential
    // timeout failures on slower builds.
    { assertIndividualRules: false }
  );
  await assertDNRGetAvailableStaticRuleCount(
    extension,
    0,
    "Expect no additional static rules count available"
  );

  info("Expect invalid rules to not be counted towards the limits");
  extension.sendMessage("updateEnabledRulesets", {
    disableRulesetIds: ["ruleset_1", "ruleset_empty"],
    enableRulesetIds: ["ruleset_withInvalid"],
  });
  await extension.awaitMessage("updateEnabledRulesets:done");
  await assertDNRGetEnabledRulesets(extension, ["ruleset_withInvalid"]);
  await assertDNRStoreData(dnrStore, extension, {
    // Only the valid rule has been actually loaded, and the invalid one
    // ignored.
    ruleset_withInvalid: [ruleValid],
  });
  await assertDNRGetAvailableStaticRuleCount(
    extension,
    availableStaticRulesCount - 1,
    "Expect only valid rules to be counted"
  );

  await extension.unload();
});

add_task(async function test_static_rulesets_limits() {
  const dnrStore = ExtensionDNRStore._getStoreForTesting();

  const getRulesetManifestData = (rulesetNumber, enabled) => {
    return {
      id: `ruleset_${rulesetNumber}`,
      enabled,
      path: `ruleset_${rulesetNumber}.json`,
    };
  };
  const {
    MAX_NUMBER_OF_STATIC_RULESETS,
    MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
  } = ExtensionDNR.limits;

  equal(
    typeof MAX_NUMBER_OF_STATIC_RULESETS,
    "number",
    "Expect MAX_NUMBER_OF_STATIC_RULESETS to be a number"
  );
  equal(
    typeof MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
    "number",
    "Expect MAX_NUMBER_OF_ENABLED_STATIC_RULESETS to be a number"
  );
  ok(
    MAX_NUMBER_OF_STATIC_RULESETS > MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
    "Expect MAX_NUMBER_OF_STATIC_RULESETS to be greater"
  );

  const rules = [getDNRRule()];

  const rule_resources = [];
  const files = {};
  for (let i = 0; i < MAX_NUMBER_OF_STATIC_RULESETS + 1; i++) {
    const enabled = i < MAX_NUMBER_OF_ENABLED_STATIC_RULESETS + 1;
    files[`ruleset_${i}.json`] = JSON.stringify(rules);
    rule_resources.push(getRulesetManifestData(i, enabled));
  }

  let extension = ExtensionTestUtils.loadExtension(
    getDNRExtension({
      rule_resources,
      files,
    })
  );

  const expectedEnabledRulesets = {};

  const { messages } = await AddonTestUtils.promiseConsoleOutput(async () => {
    ExtensionTestUtils.failOnSchemaWarnings(false);
    await extension.startup();
    ExtensionTestUtils.failOnSchemaWarnings(true);
    await extension.awaitMessage("bgpage:ready");

    for (let i = 0; i < MAX_NUMBER_OF_ENABLED_STATIC_RULESETS; i++) {
      expectedEnabledRulesets[`ruleset_${i}`] = getSchemaNormalizedRules(
        extension,
        rules
      );
    }

    await assertDNRGetEnabledRulesets(
      extension,
      Array.from(Object.keys(expectedEnabledRulesets))
    );
    await assertDNRStoreData(dnrStore, extension, expectedEnabledRulesets);
  });

  AddonTestUtils.checkMessages(messages, {
    expected: [
      // Warnings emitted from the manifest schema validation.
      {
        message: /declarative_net_request: Static rulesets are exceeding the MAX_NUMBER_OF_STATIC_RULESETS limit/,
      },
      {
        message: /declarative_net_request: Enabled static rulesets are exceeding the MAX_NUMBER_OF_ENABLED_STATIC_RULESETS limit .* "ruleset_10"/,
      },
      // Error reported on the browser console as part of loading enabled rulesets)
      // on enabled rulesets being ignored because exceeding the limit.
      {
        message: /Ignoring enabled static ruleset exceeding the MAX_NUMBER_OF_ENABLED_STATIC_RULESETS .* "ruleset_10"/,
      },
    ],
  });

  info(
    "Verify updateEnabledRulesets reject when the request is exceeding the enabled rulesets count limit"
  );
  extension.sendMessage("updateEnabledRulesets", {
    disableRulesetIds: ["ruleset_0"],
    enableRulesetIds: ["ruleset_10", "ruleset_11"],
  });

  await Assert.rejects(
    extension.awaitMessage("updateEnabledRulesets:done").then(results => {
      if (results[0].rejectedWithErrorMessage) {
        return Promise.reject(new Error(results[0].rejectedWithErrorMessage));
      }
      return results[0];
    }),
    /updatedEnabledRulesets request is exceeding MAX_NUMBER_OF_ENABLED_STATIC_RULESETS/,
    "Expected rejection on updateEnabledRulesets exceeting enabled rulesets count limit"
  );

  // Confirm that the expected rulesets didn't change neither.
  await assertDNRGetEnabledRulesets(
    extension,
    Array.from(Object.keys(expectedEnabledRulesets))
  );
  await assertDNRStoreData(dnrStore, extension, expectedEnabledRulesets);

  info(
    "Verify updateEnabledRulesets applies the expected changes when resolves successfully"
  );
  extension.sendMessage(
    "updateEnabledRulesets",
    {
      disableRulesetIds: ["ruleset_0"],
      enableRulesetIds: ["ruleset_10"],
    },
    {
      disableRulesetIds: ["ruleset_10"],
      enableRulesetIds: ["ruleset_11"],
    }
  );
  await extension.awaitMessage("updateEnabledRulesets:done");

  // Expect ruleset_0 disabled, ruleset_10 to be enabled but then disabled by the
  // second update queued after the first one, and ruleset_11 to be enabled.
  delete expectedEnabledRulesets.ruleset_0;
  expectedEnabledRulesets.ruleset_11 = getSchemaNormalizedRules(
    extension,
    rules
  );

  await assertDNRGetEnabledRulesets(
    extension,
    Array.from(Object.keys(expectedEnabledRulesets))
  );
  await assertDNRStoreData(dnrStore, extension, expectedEnabledRulesets);

  // Ensure all changes were stored and reloaded from disk store and the
  // DNR store update queue can accept new updates.
  info("Verify static rules load and updates after extension is restarted");
  await AddonTestUtils.promiseRestartManager();
  await extension.awaitStartup();
  await extension.awaitMessage("bgpage:ready");
  await assertDNRGetEnabledRulesets(
    extension,
    Array.from(Object.keys(expectedEnabledRulesets))
  );
  await assertDNRStoreData(dnrStore, extension, expectedEnabledRulesets);

  extension.sendMessage("updateEnabledRulesets", {
    disableRulesetIds: ["ruleset_11"],
  });
  await extension.awaitMessage("updateEnabledRulesets:done");
  delete expectedEnabledRulesets.ruleset_11;
  await assertDNRGetEnabledRulesets(
    extension,
    Array.from(Object.keys(expectedEnabledRulesets))
  );
  await assertDNRStoreData(dnrStore, extension, expectedEnabledRulesets);

  await extension.unload();
});
