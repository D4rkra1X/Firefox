/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

"use strict";

function genUUID() {
  return Services.uuid.generateUUID().number.slice(1, -1);
}

add_setup(async function() {
  registerCleanupFunction(() => {
    Services.prefs.clearUserPref("cookiebanners.service.mode");
    Services.prefs.clearUserPref("cookiebanners.service.mode.privateBrowsing");
    if (
      Services.prefs.getIntPref("cookiebanners.service.mode") !=
        Ci.nsICookieBannerService.MODE_DISABLED ||
      Services.prefs.getIntPref("cookiebanners.service.mode.privateBrowsing") !=
        Ci.nsICookieBannerService.MODE_DISABLED
    ) {
      // Restore original rules.
      Services.cookieBanners.resetRules(true);
    }
  });
});

add_task(async function test_enabled_pref() {
  info("Disabling cookie banner service.");

  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_DISABLED],
      [
        "cookiebanners.service.mode.privateBrowsing",
        Ci.nsICookieBannerService.MODE_DISABLED,
      ],
    ],
  });

  ok(Services.cookieBanners, "Services.cookieBanners is defined.");
  ok(
    Services.cookieBanners instanceof Ci.nsICookieBannerService,
    "Services.cookieBanners is nsICookieBannerService"
  );

  info(
    "Testing that methods throw NS_ERROR_NOT_AVAILABLE if the service is disabled."
  );

  Assert.throws(
    () => {
      Services.cookieBanners.rules;
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for rules getter."
  );

  // Create a test rule to attempt to insert.
  let rule = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  rule.id = genUUID();
  rule.domain = "example.com";

  Assert.throws(
    () => {
      Services.cookieBanners.insertRule(rule);
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for insertRule."
  );

  Assert.throws(
    () => {
      Services.cookieBanners.removeRule(rule);
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for removeRule."
  );

  Assert.throws(
    () => {
      Services.cookieBanners.getCookiesForURI(
        Services.io.newURI("https://example.com"),
        false
      );
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for rules getCookiesForURI."
  );
  Assert.throws(
    () => {
      Services.cookieBanners.getClickRulesForDomain("example.com", true);
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for rules getClickRuleForDomain."
  );
  let uri = Services.io.newURI("https://example.com");
  Assert.throws(
    () => {
      Services.cookieBanners.getDomainPref(uri, false);
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for getDomainPref."
  );
  Assert.throws(
    () => {
      Services.cookieBanners.setDomainPref(
        uri,
        Ci.nsICookieBannerService.MODE_REJECT,
        false
      );
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for setDomainPref."
  );
  Assert.throws(
    () => {
      Services.cookieBanners.removeDomainPref(uri, false);
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for removeDomainPref."
  );
  Assert.throws(
    () => {
      Services.cookieBanners.removeAllDomainPrefs(false);
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for removeAllSitePref."
  );

  info("Enabling cookie banner service. MODE_REJECT");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_REJECT],
    ],
  });

  let rules = Services.cookieBanners.rules;
  ok(
    Array.isArray(rules),
    "Rules getter should not throw but return an array."
  );

  info("Enabling cookie banner service. MODE_REJECT_OR_ACCEPT");
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "cookiebanners.service.mode",
        Ci.nsICookieBannerService.MODE_REJECT_OR_ACCEPT,
      ],
    ],
  });

  rules = Services.cookieBanners.rules;
  ok(
    Array.isArray(rules),
    "Rules getter should not throw but return an array."
  );

  info("Enabling cookie banner service. MODE_DETECT_ONLY");
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "cookiebanners.service.mode",
        Ci.nsICookieBannerService.MODE_DETECT_ONLY,
      ],
    ],
  });

  rules = Services.cookieBanners.rules;
  ok(
    Array.isArray(rules),
    "Rules getter should not throw but return an array."
  );
});

/**
 * Test both service mode pref combinations to ensure the cookie banner service
 * is (un-)initialized correctly.
 */
add_task(async function test_enabled_pref_pbm_combinations() {
  const MODES = [
    Ci.nsICookieBannerService.MODE_DISABLED,
    Ci.nsICookieBannerService.MODE_REJECT,
    Ci.nsICookieBannerService.MODE_REJECT_OR_ACCEPT,
    Ci.nsICookieBannerService.MODE_DETECT_ONLY,
  ];

  // Test all pref combinations
  MODES.forEach(modeNormal => {
    MODES.forEach(modePrivate => {
      info(
        `cookiebanners.service.mode=${modeNormal}; cookiebanners.service.mode.privateBrowsing=${modePrivate}`
      );
      Services.prefs.setIntPref("cookiebanners.service.mode", modeNormal);
      Services.prefs.setIntPref(
        "cookiebanners.service.mode.privateBrowsing",
        modePrivate
      );

      if (
        modeNormal == Ci.nsICookieBannerService.MODE_DISABLED &&
        modePrivate == Ci.nsICookieBannerService.MODE_DISABLED
      ) {
        Assert.throws(
          () => {
            Services.cookieBanners.rules;
          },
          /NS_ERROR_NOT_AVAILABLE/,
          "Cookie banner service should be disabled. Should throw NS_ERROR_NOT_AVAILABLE for rules getter."
        );
      } else {
        ok(
          Services.cookieBanners.rules,
          "Cookie banner service should be enabled, rules getter should not throw."
        );
      }
    });
  });

  // Cleanup.
  Services.prefs.clearUserPref("cookiebanners.service.mode");
  Services.prefs.clearUserPref("cookiebanners.service.mode.privateBrowsing");
});

add_task(async function test_insertAndGetRule() {
  info("Enabling cookie banner service with MODE_REJECT");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_REJECT],
    ],
  });

  info("Clear any preexisting rules");
  Services.cookieBanners.resetRules(false);

  is(
    Services.cookieBanners.rules.length,
    0,
    "Cookie banner service has no rules initially."
  );

  info("Test that we can't import rules with empty domain field.");
  let ruleInvalid = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  Assert.throws(
    () => {
      Services.cookieBanners.insertRule(ruleInvalid);
    },
    /NS_ERROR_FAILURE/,
    "Inserting an invalid rule missing a domain should throw."
  );

  let rule = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  rule.domain = "example.com";

  Services.cookieBanners.insertRule(rule);

  is(
    rule.cookiesOptOut.length,
    0,
    "Should not have any opt-out cookies initially"
  );
  is(
    rule.cookiesOptIn.length,
    0,
    "Should not have any opt-in cookies initially"
  );

  info("Clearing preexisting cookies rules for example.com.");
  rule.clearCookies();

  info("Adding cookies to the rule for example.com.");
  rule.addCookie(
    true,
    "foo",
    "bar",
    "example.com",
    "/",
    3600,
    "",
    false,
    false,
    false,
    0,
    0
  );
  rule.addCookie(
    true,
    "foobar",
    "barfoo",
    "example.com",
    "/",
    3600,
    "",
    false,
    false,
    false,
    0,
    0
  );
  rule.addCookie(
    false,
    "foo",
    "bar",
    "foo.example.com",
    "/myPath",
    3600,
    "",
    false,
    false,
    true,
    0,
    0
  );

  info("Adding a click rule to the rule for example.com.");
  rule.addClickRule(
    "div#presence",
    false,
    Ci.nsIClickRule.RUN_TOP,
    "div#hide",
    "div#optOut",
    "div#optIn"
  );

  is(rule.cookiesOptOut.length, 2, "Should have two opt-out cookies.");
  is(rule.cookiesOptIn.length, 1, "Should have one opt-in cookie.");

  is(
    Services.cookieBanners.rules.length,
    1,
    "Cookie Banner Service has one rule."
  );

  let rule2 = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  rule2.domain = "example.org";

  Services.cookieBanners.insertRule(rule2);
  info("Clearing preexisting cookies rules for example.org.");
  rule2.clearCookies();

  info("Adding a cookie to the rule for example.org.");
  rule2.addCookie(
    false,
    "foo2",
    "bar2",
    "example.org",
    "/",
    0,
    "",
    false,
    false,
    false,
    0,
    0
  );

  info("Adding a click rule to the rule for example.org.");
  rule2.addClickRule(
    "div#presence",
    false,
    Ci.nsIClickRule.RUN_TOP,
    null,
    null,
    "div#optIn"
  );

  is(
    Services.cookieBanners.rules.length,
    2,
    "Cookie Banner Service has two rules."
  );

  info("Getting cookies by URI for example.com.");
  let ruleArray = Services.cookieBanners.getCookiesForURI(
    Services.io.newURI("http://example.com"),
    false
  );
  ok(
    ruleArray && Array.isArray(ruleArray),
    "getCookiesForURI should return a rule array."
  );
  is(ruleArray.length, 2, "rule array should contain 2 rules.");
  ruleArray.every(rule => {
    ok(rule instanceof Ci.nsICookieRule, "Rule should have correct type.");
    is(rule.cookie.host, "example.com", "Rule should have correct host.");
  });

  info("Clearing cookies of rule.");
  rule.clearCookies();
  is(rule.cookiesOptOut.length, 0, "Should have no opt-out cookies.");
  is(rule.cookiesOptIn.length, 0, "Should have no opt-in cookies.");

  info("Getting the click rule for example.com.");
  let clickRules = Services.cookieBanners.getClickRulesForDomain(
    "example.com",
    true
  );
  is(
    clickRules.length,
    1,
    "There should be one domain-specific click rule for example.com"
  );
  let [clickRule] = clickRules;

  is(
    clickRule.presence,
    "div#presence",
    "Should have the correct presence selector."
  );
  is(clickRule.hide, "div#hide", "Should have the correct hide selector.");
  is(
    clickRule.optOut,
    "div#optOut",
    "Should have the correct optOut selector."
  );
  is(clickRule.optIn, "div#optIn", "Should have the correct optIn selector.");

  info("Getting cookies by URI for example.org.");
  let ruleArray2 = Services.cookieBanners.getCookiesForURI(
    Services.io.newURI("http://example.org"),
    false
  );
  ok(
    ruleArray2 && Array.isArray(ruleArray2),
    "getCookiesForURI should return a rule array."
  );
  is(
    ruleArray2.length,
    0,
    "rule array should contain no rules in MODE_REJECT (opt-out only)"
  );

  info("Getting the click rule for example.org.");
  let clickRules2 = Services.cookieBanners.getClickRulesForDomain(
    "example.org",
    true
  );
  is(
    clickRules2.length,
    1,
    "There should be one domain-specific click rule for example.org"
  );
  let [clickRule2] = clickRules2;
  is(
    clickRule2.presence,
    "div#presence",
    "Should have the correct presence selector."
  );
  ok(!clickRule2.hide, "Should have no hide selector.");
  ok(!clickRule2.optOut, "Should have no target selector.");
  is(clickRule.optIn, "div#optIn", "Should have the correct optIn selector.");

  info("Switching cookiebanners.service.mode to MODE_REJECT_OR_ACCEPT.");
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        "cookiebanners.service.mode",
        Ci.nsICookieBannerService.MODE_REJECT_OR_ACCEPT,
      ],
    ],
  });

  ruleArray2 = Services.cookieBanners.getCookiesForURI(
    Services.io.newURI("http://example.org"),
    false
  );
  ok(
    ruleArray2 && Array.isArray(ruleArray2),
    "getCookiesForURI should return a rule array."
  );
  is(
    ruleArray2.length,
    1,
    "rule array should contain one rule in mode MODE_REJECT_OR_ACCEPT (opt-out or opt-in)"
  );

  info("Calling getCookiesForURI for unknown domain.");
  let ruleArrayUnknown = Services.cookieBanners.getCookiesForURI(
    Services.io.newURI("http://example.net"),
    false
  );
  ok(
    ruleArrayUnknown && Array.isArray(ruleArrayUnknown),
    "getCookiesForURI should return a rule array."
  );
  is(ruleArrayUnknown.length, 0, "rule array should contain no rules.");

  // Cleanup.
  Services.cookieBanners.resetRules(false);
});

add_task(async function test_removeRule() {
  info("Enabling cookie banner service with MODE_REJECT");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_REJECT],
    ],
  });

  info("Clear any preexisting rules");
  Services.cookieBanners.resetRules(false);

  is(
    Services.cookieBanners.rules.length,
    0,
    "Cookie banner service has no rules initially."
  );

  let rule = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  rule.id = genUUID();
  rule.domain = "example.com";

  Services.cookieBanners.insertRule(rule);

  let rule2 = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  rule2.id = genUUID();
  rule2.domain = "example.org";

  Services.cookieBanners.insertRule(rule2);

  is(
    Services.cookieBanners.rules.length,
    2,
    "Cookie banner service two rules after insert."
  );

  info("Removing rule for non existent example.net");
  let ruleExampleNet = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  ruleExampleNet.id = genUUID();
  ruleExampleNet.domain = "example.net";
  Services.cookieBanners.removeRule(ruleExampleNet);

  is(
    Services.cookieBanners.rules.length,
    2,
    "Cookie banner service still has two rules."
  );

  info("Removing rule for non existent global rule.");
  let ruleGlobal = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  ruleGlobal.id = genUUID();
  ruleGlobal.domain = "*";
  Services.cookieBanners.removeRule(ruleGlobal);

  is(
    Services.cookieBanners.rules.length,
    2,
    "Cookie banner service still has two rules."
  );

  info("Removing rule for example.com");
  Services.cookieBanners.removeRule(rule);

  is(
    Services.cookieBanners.rules.length,
    1,
    "Cookie banner service should have one rule left after remove."
  );

  is(
    Services.cookieBanners.rules[0].domain,
    "example.org",
    "It should be the example.org rule."
  );

  // Cleanup.
  Services.cookieBanners.resetRules(false);
});

add_task(async function test_overwriteRule() {
  info("Enabling cookie banner service with MODE_REJECT");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_REJECT],
    ],
  });

  info("Clear any preexisting rules");
  Services.cookieBanners.resetRules(false);

  is(
    Services.cookieBanners.rules.length,
    0,
    "Cookie banner service has no rules initially."
  );

  let rule = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  rule.domain = "example.com";

  info("Adding a cookie so we can detect if the rule updates.");
  rule.addCookie(
    true,
    "foo",
    "original",
    "example.com",
    "/",
    3600,
    "",
    false,
    false,
    false,
    0,
    0
  );

  info("Adding a click rule so we can detect if the rule updates.");
  rule.addClickRule("div#original");

  Services.cookieBanners.insertRule(rule);

  let { cookie } = Services.cookieBanners.rules[0].cookiesOptOut[0];

  is(cookie.name, "foo", "Should have set the correct cookie name.");
  is(cookie.value, "original", "Should have set the correct cookie value.");

  info("Add a new rule with the same domain. It should be overwritten.");

  let ruleNew = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  ruleNew.domain = "example.com";

  ruleNew.addCookie(
    true,
    "foo",
    "new",
    "example.com",
    "/",
    3600,
    "",
    false,
    false,
    false,
    0,
    0
  );

  ruleNew.addClickRule("div#new");

  Services.cookieBanners.insertRule(ruleNew);

  let { cookie: cookieNew } = Services.cookieBanners.rules[0].cookiesOptOut[0];
  is(cookieNew.name, "foo", "Should have set the original cookie name.");
  is(cookieNew.value, "new", "Should have set the updated cookie value.");

  let { presence: presenceNew } = Services.cookieBanners.rules[0].clickRule;
  is(presenceNew, "div#new", "Should have set the updated presence value");

  // Cleanup.
  Services.cookieBanners.resetRules(false);
});

add_task(async function test_globalRules() {
  info("Enabling cookie banner service with MODE_REJECT");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_REJECT],
      ["cookiebanners.service.enableGlobalRules", true],
    ],
  });

  info("Clear any preexisting rules");
  Services.cookieBanners.resetRules(false);

  is(
    Services.cookieBanners.rules.length,
    0,
    "Cookie banner service has no rules initially."
  );

  info("Insert a site-specific rule for example.com");
  let rule = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  rule.id = genUUID();
  rule.domain = "example.com";
  rule.addCookie(
    true,
    "foo",
    "new",
    "example.com",
    "/",
    3600,
    "",
    false,
    false,
    false,
    0,
    0
  );
  rule.addClickRule(
    "#cookieBannerExample",
    false,
    Ci.nsIClickRule.RUN_TOP,
    "#btnOptOut",
    "#btnOptIn"
  );
  Services.cookieBanners.insertRule(rule);

  info(
    "Insert a global rule with a cookie and a click rule. The cookie rule shouldn't be used."
  );
  let ruleGlobalA = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  ruleGlobalA.id = genUUID();
  ruleGlobalA.domain = "*";
  ruleGlobalA.addCookie(
    true,
    "foo",
    "new",
    "example.net",
    "/",
    3600,
    "",
    false,
    false,
    false,
    0,
    0
  );
  ruleGlobalA.addClickRule(
    "#globalCookieBanner",
    false,
    Ci.nsIClickRule.RUN_TOP,
    "#btnOptOut",
    "#btnOptIn"
  );
  Services.cookieBanners.insertRule(ruleGlobalA);

  info("Insert a second global rule");
  let ruleGlobalB = Cc["@mozilla.org/cookie-banner-rule;1"].createInstance(
    Ci.nsICookieBannerRule
  );
  ruleGlobalB.id = genUUID();
  ruleGlobalB.domain = "*";
  ruleGlobalB.addClickRule(
    "#globalCookieBannerB",
    false,
    Ci.nsIClickRule.RUN_TOP,
    "#btnOptOutB",
    "#btnOptIn"
  );
  Services.cookieBanners.insertRule(ruleGlobalB);

  is(
    Services.cookieBanners.rules.length,
    3,
    "Cookie Banner Service has three rules."
  );

  is(
    Services.cookieBanners.getCookiesForURI(
      Services.io.newURI("http://example.com"),
      false
    ).length,
    1,
    "There should be a cookie rule for example.com"
  );

  is(
    Services.cookieBanners.getClickRulesForDomain("example.com", true).length,
    1,
    "There should be a a click rule for example.com"
  );

  is(
    Services.cookieBanners.getCookiesForURI(
      Services.io.newURI("http://thishasnorule.com"),
      false
    ).length,
    0,
    "There should be no cookie rule for thishasnorule.com"
  );

  let clickRules = Services.cookieBanners.getClickRulesForDomain(
    Services.io.newURI("http://thishasnorule.com"),
    true
  );
  is(
    clickRules.length,
    2,
    "There should be two click rules for thishasnorule.com"
  );
  ok(
    clickRules.every(rule => rule.presence.startsWith("#globalCookieBanner")),
    "The returned click rules should be global rules."
  );

  info("Disabling global rules");
  await SpecialPowers.pushPrefEnv({
    set: [["cookiebanners.service.enableGlobalRules", false]],
  });

  is(
    Services.cookieBanners.rules.length,
    1,
    "Cookie Banner Service has 1 rule."
  );

  is(
    Services.cookieBanners.rules[0].id,
    rule.id,
    "It should be the domain specific rule"
  );

  is(
    Services.cookieBanners.getCookiesForURI(
      Services.io.newURI("http://thishasnorule.com"),
      false
    ).length,
    0,
    "There should be no cookie rule for thishasnorule.com"
  );

  is(
    Services.cookieBanners.getClickRulesForDomain(
      Services.io.newURI("http://thishasnorule.com"),
      true
    ).length,
    0,
    "There should be no click rules for thishasnorule.com since global rules are disabled"
  );
});

add_task(async function test_domain_preference() {
  info("Enabling cookie banner service with MODE_REJECT");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_REJECT],
    ],
  });

  let uri = Services.io.newURI("http://example.com");

  // Check no site preference at the beginning
  is(
    Services.cookieBanners.getDomainPref(uri, false),
    Ci.nsICookieBannerService.MODE_UNSET,
    "There should be no per site preference at the beginning."
  );

  // Check setting and getting a site preference.
  Services.cookieBanners.setDomainPref(
    uri,
    Ci.nsICookieBannerService.MODE_REJECT,
    false
  );

  is(
    Services.cookieBanners.getDomainPref(uri, false),
    Ci.nsICookieBannerService.MODE_REJECT,
    "Can get site preference for example.com with the correct value."
  );

  // Check site preference is shared between http and https.
  let uriHttps = Services.io.newURI("https://example.com");
  is(
    Services.cookieBanners.getDomainPref(uriHttps, false),
    Ci.nsICookieBannerService.MODE_REJECT,
    "Can get site preference for example.com in secure context."
  );

  // Check site preference in the other domain, example.org.
  let uriOther = Services.io.newURI("http://example.org");
  is(
    Services.cookieBanners.getDomainPref(uriOther, false),
    Ci.nsICookieBannerService.MODE_UNSET,
    "There should be no domain preference for example.org."
  );

  // Check setting site preference won't affect the other domain.
  Services.cookieBanners.setDomainPref(
    uriOther,
    Ci.nsICookieBannerService.MODE_REJECT_OR_ACCEPT,
    false
  );

  is(
    Services.cookieBanners.getDomainPref(uriOther, false),
    Ci.nsICookieBannerService.MODE_REJECT_OR_ACCEPT,
    "Can get domain preference for example.org with the correct value."
  );
  is(
    Services.cookieBanners.getDomainPref(uri, false),
    Ci.nsICookieBannerService.MODE_REJECT,
    "Can get site preference for example.com"
  );

  // Check removing the site preference.
  Services.cookieBanners.removeDomainPref(uri, false);
  is(
    Services.cookieBanners.getDomainPref(uri, false),
    Ci.nsICookieBannerService.MODE_UNSET,
    "There should be no site preference for example.com."
  );

  // Check remove all site preferences.
  Services.cookieBanners.removeAllDomainPrefs(false);
  is(
    Services.cookieBanners.getDomainPref(uri, false),
    Ci.nsICookieBannerService.MODE_UNSET,
    "There should be no site preference for example.com."
  );
  is(
    Services.cookieBanners.getDomainPref(uriOther, false),
    Ci.nsICookieBannerService.MODE_UNSET,
    "There should be no site preference for example.org."
  );
});

add_task(async function test_domain_preference_dont_override_disable_pref() {
  info("Enabling cookie banner service with MODE_REJECT");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_REJECT],
    ],
  });

  info("Adding a domain preference for example.com");
  let uri = Services.io.newURI("http://example.com");

  // Set a domain preference.
  Services.cookieBanners.setDomainPref(
    uri,
    Ci.nsICookieBannerService.MODE_REJECT,
    false
  );

  info("Disabling the cookie banner service.");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_DISABLED],
      [
        "cookiebanners.service.mode.privateBrowsing",
        Ci.nsICookieBannerService.MODE_DISABLED,
      ],
    ],
  });

  info("Verifying if the cookie banner service is disabled.");
  Assert.throws(
    () => {
      Services.cookieBanners.getDomainPref(uri, false);
    },
    /NS_ERROR_NOT_AVAILABLE/,
    "Should have thrown NS_ERROR_NOT_AVAILABLE for getDomainPref."
  );

  info("Enable the service again in order to clear the domain prefs.");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_REJECT],
    ],
  });
  Services.cookieBanners.removeAllDomainPrefs(false);
});

/**
 * Test that domain preference is properly cleared when private browsing session
 * ends.
 */
add_task(async function test_domain_preference_cleared_PBM_ends() {
  info("Enabling cookie banner service with MODE_REJECT");
  await SpecialPowers.pushPrefEnv({
    set: [
      ["cookiebanners.service.mode", Ci.nsICookieBannerService.MODE_REJECT],
    ],
  });

  info("Adding a domain preference for example.com in PBM");
  let uri = Services.io.newURI("http://example.com");

  info("Open a private browsing window.");
  let PBMWin = await BrowserTestUtils.openNewBrowserWindow({
    private: true,
  });

  // Set a domain preference for PBM.
  Services.cookieBanners.setDomainPref(
    uri,
    Ci.nsICookieBannerService.MODE_DISABLED,
    true
  );

  info("Verifying if the cookie banner domain pref is set for PBM.");
  is(
    Services.cookieBanners.getDomainPref(uri, true),
    Ci.nsICookieBannerService.MODE_DISABLED,
    "The domain pref is properly set for PBM."
  );

  info("Trigger an ending of a private browsing window session");
  let PBMSessionEndsObserved = TestUtils.topicObserved(
    "last-pb-context-exited"
  );

  // Close the PBM window and wait until it finishes.
  await BrowserTestUtils.closeWindow(PBMWin);
  await PBMSessionEndsObserved;

  info("Verify if the private domain pref is cleared.");
  is(
    Services.cookieBanners.getDomainPref(uri, true),
    Ci.nsICookieBannerService.MODE_UNSET,
    "The domain pref is properly set for PBM."
  );
});
