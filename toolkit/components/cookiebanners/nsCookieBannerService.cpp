/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include "nsCookieBannerService.h"

#include "CookieBannerDomainPrefService.h"
#include "ErrorList.h"
#include "mozilla/ClearOnShutdown.h"
#include "mozilla/dom/CanonicalBrowsingContext.h"
#include "mozilla/EventQueue.h"
#include "mozilla/glean/GleanMetrics.h"
#include "mozilla/Logging.h"
#include "mozilla/StaticPrefs_cookiebanners.h"
#include "nsCOMPtr.h"
#include "nsCookieBannerRule.h"
#include "nsCookieInjector.h"
#include "nsCRT.h"
#include "nsDebug.h"
#include "nsIClickRule.h"
#include "nsICookieBannerListService.h"
#include "nsICookieBannerRule.h"
#include "nsICookie.h"
#include "nsIEffectiveTLDService.h"
#include "nsNetCID.h"
#include "nsServiceManagerUtils.h"
#include "nsThreadUtils.h"

namespace mozilla {

NS_IMPL_ISUPPORTS(nsCookieBannerService, nsICookieBannerService, nsIObserver)

LazyLogModule gCookieBannerLog("nsCookieBannerService");

static const char kCookieBannerServiceModePref[] = "cookiebanners.service.mode";
static const char kCookieBannerServiceModePBMPref[] =
    "cookiebanners.service.mode.privateBrowsing";

static StaticRefPtr<nsCookieBannerService> sCookieBannerServiceSingleton;

namespace {

// A helper function that converts service modes to strings.
nsCString ConvertModeToStringForTelemetry(uint32_t aModes) {
  switch (aModes) {
    case nsICookieBannerService::MODE_DISABLED:
      return "disabled"_ns;
    case nsICookieBannerService::MODE_REJECT:
      return "reject"_ns;
    case nsICookieBannerService::MODE_REJECT_OR_ACCEPT:
      return "reject_or_accept"_ns;
    case nsICookieBannerService::MODE_DETECT_ONLY:
      return "detect_only"_ns;
    default:
      // Fall back to return "invalid" if we got any unsupported service
      // mode. Note this this also includes MODE_UNSET.
      return "invalid"_ns;
  }
}

}  // anonymous namespace

// static
already_AddRefed<nsCookieBannerService> nsCookieBannerService::GetSingleton() {
  if (!sCookieBannerServiceSingleton) {
    sCookieBannerServiceSingleton = new nsCookieBannerService();

    RunOnShutdown([] {
      MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
              ("RunOnShutdown. Mode: %d. Mode PBM: %d.",
               StaticPrefs::cookiebanners_service_mode(),
               StaticPrefs::cookiebanners_service_mode_privateBrowsing()));

      // Unregister pref listeners.
      DebugOnly<nsresult> rv = Preferences::UnregisterCallback(
          &nsCookieBannerService::OnPrefChange, kCookieBannerServiceModePref);
      NS_WARNING_ASSERTION(
          NS_SUCCEEDED(rv),
          "Unregistering kCookieBannerServiceModePref callback failed");
      rv = Preferences::UnregisterCallback(&nsCookieBannerService::OnPrefChange,
                                           kCookieBannerServiceModePBMPref);
      NS_WARNING_ASSERTION(
          NS_SUCCEEDED(rv),
          "Unregistering kCookieBannerServiceModePBMPref callback failed");

      rv = sCookieBannerServiceSingleton->Shutdown();
      NS_WARNING_ASSERTION(NS_SUCCEEDED(rv),
                           "nsCookieBannerService::Shutdown failed.");

      sCookieBannerServiceSingleton = nullptr;
    });
  }

  return do_AddRef(sCookieBannerServiceSingleton);
}

// static
void nsCookieBannerService::OnPrefChange(const char* aPref, void* aData) {
  RefPtr<nsCookieBannerService> service = GetSingleton();

  // If the feature is enabled for normal or private browsing, init the service.
  if (StaticPrefs::cookiebanners_service_mode() !=
          nsICookieBannerService::MODE_DISABLED ||
      StaticPrefs::cookiebanners_service_mode_privateBrowsing() !=
          nsICookieBannerService::MODE_DISABLED) {
    MOZ_LOG(
        gCookieBannerLog, LogLevel::Info,
        ("Initializing nsCookieBannerService after pref change. %s", aPref));
    DebugOnly<nsresult> rv = service->Init();
    NS_WARNING_ASSERTION(NS_SUCCEEDED(rv),
                         "nsCookieBannerService::Init failed");
    return;
  }

  MOZ_LOG(gCookieBannerLog, LogLevel::Info,
          ("Disabling nsCookieBannerService after pref change. %s", aPref));

  DebugOnly<nsresult> rv = service->Shutdown();
  NS_WARNING_ASSERTION(NS_SUCCEEDED(rv),
                       "nsCookieBannerService::Shutdown failed");
}

NS_IMETHODIMP
nsCookieBannerService::Observe(nsISupports* aSubject, const char* aTopic,
                               const char16_t* aData) {
  // Report the daily telemetry for the cookie banner service on "idle-daily".
  if (nsCRT::strcmp(aTopic, "idle-daily") == 0) {
    DailyReportTelemetry();
    return NS_OK;
  }

  // Initializing the cookie banner service on startup on
  // "profile-after-change".
  if (nsCRT::strcmp(aTopic, "profile-after-change") == 0) {
    nsresult rv = Preferences::RegisterCallback(
        &nsCookieBannerService::OnPrefChange, kCookieBannerServiceModePBMPref);
    NS_ENSURE_SUCCESS(rv, rv);

    return Preferences::RegisterCallbackAndCall(
        &nsCookieBannerService::OnPrefChange, kCookieBannerServiceModePref);
  }

  return NS_OK;
}

nsresult nsCookieBannerService::Init() {
  MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
          ("%s. Mode: %d. Mode PBM: %d.", __FUNCTION__,
           StaticPrefs::cookiebanners_service_mode(),
           StaticPrefs::cookiebanners_service_mode_privateBrowsing()));

  // Check if already initialized.
  if (mIsInitialized) {
    return NS_OK;
  }

  // Initialize the service which fetches cookie banner rules.
  mListService = do_GetService(NS_COOKIEBANNERLISTSERVICE_CONTRACTID);
  NS_ENSURE_TRUE(mListService, NS_ERROR_FAILURE);

  mDomainPrefService = CookieBannerDomainPrefService::GetOrCreate();
  NS_ENSURE_TRUE(mDomainPrefService, NS_ERROR_FAILURE);

  // Setting mIsInitialized before importing rules, because the list service
  // needs to call nsCookieBannerService methods that would throw if not
  // marked initialized.
  mIsInitialized = true;

  // Import initial rule-set, domain preference and enable rule syncing. Uses
  // NS_DispatchToCurrentThreadQueue with idle priority to avoid early
  // main-thread IO caused by the list service accessing RemoteSettings.
  nsresult rv = NS_DispatchToCurrentThreadQueue(
      NS_NewRunnableFunction("CookieBannerListService init startup",
                             [&] {
                               mListService->Init();
                               mDomainPrefService->Init();
                             }),
      EventQueuePriority::Idle);
  NS_ENSURE_SUCCESS(rv, rv);

  // Initialize the cookie injector.
  RefPtr<nsCookieInjector> injector = nsCookieInjector::GetSingleton();

  return NS_OK;
}

nsresult nsCookieBannerService::Shutdown() {
  MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
          ("%s. Mode: %d. Mode PBM: %d.", __FUNCTION__,
           StaticPrefs::cookiebanners_service_mode(),
           StaticPrefs::cookiebanners_service_mode_privateBrowsing()));

  // Check if already shutdown.
  if (!mIsInitialized) {
    return NS_OK;
  }
  mIsInitialized = false;

  // Shut down the list service which will stop updating mRules.
  mListService->Shutdown();

  // Clear all stored cookie banner rules. They will be imported again on Init.
  mRules.Clear();

  return NS_OK;
}

NS_IMETHODIMP
nsCookieBannerService::GetRules(nsTArray<RefPtr<nsICookieBannerRule>>& aRules) {
  aRules.Clear();

  // Service is disabled, throw with empty array.
  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  if (StaticPrefs::cookiebanners_service_enableGlobalRules()) {
    AppendToArray(aRules, mGlobalRules.Values());
  }
  AppendToArray(aRules, mRules.Values());

  return NS_OK;
}

NS_IMETHODIMP
nsCookieBannerService::ResetRules(const bool doImport) {
  // Service is disabled, throw.
  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  mRules.Clear();
  mGlobalRules.Clear();

  if (doImport) {
    NS_ENSURE_TRUE(mListService, NS_ERROR_FAILURE);
    nsresult rv = mListService->ImportAllRules();
    NS_ENSURE_SUCCESS(rv, rv);
  }

  return NS_OK;
}

nsresult nsCookieBannerService::GetRuleForDomain(const nsACString& aDomain,
                                                 nsICookieBannerRule** aRule) {
  NS_ENSURE_ARG_POINTER(aRule);
  *aRule = nullptr;

  // Service is disabled, throw with null.
  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsCOMPtr<nsICookieBannerRule> rule = mRules.Get(aDomain);
  if (rule) {
    rule.forget(aRule);
  }

  return NS_OK;
}

nsresult nsCookieBannerService::GetRuleForURI(nsIURI* aURI,
                                              nsICookieBannerRule** aRule) {
  NS_ENSURE_ARG_POINTER(aURI);
  NS_ENSURE_ARG_POINTER(aRule);
  *aRule = nullptr;

  // Service is disabled, throw with null.
  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsresult rv;
  nsCOMPtr<nsIEffectiveTLDService> eTLDService(
      do_GetService(NS_EFFECTIVETLDSERVICE_CONTRACTID, &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString baseDomain;
  rv = eTLDService->GetBaseDomain(aURI, 0, baseDomain);
  NS_ENSURE_SUCCESS(rv, rv);

  return GetRuleForDomain(baseDomain, aRule);
}

NS_IMETHODIMP
nsCookieBannerService::GetCookiesForURI(
    nsIURI* aURI, const bool aIsPrivateBrowsing,
    nsTArray<RefPtr<nsICookieRule>>& aCookies) {
  NS_ENSURE_ARG_POINTER(aURI);
  aCookies.Clear();

  // We only need URI spec for logging, avoid getting it otherwise.
  if (MOZ_LOG_TEST(gCookieBannerLog, LogLevel::Debug)) {
    nsAutoCString spec;
    nsresult rv = aURI->GetSpec(spec);
    NS_ENSURE_SUCCESS(rv, rv);
    MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
            ("%s. aURI: %s. aIsPrivateBrowsing: %d", __FUNCTION__, spec.get(),
             aIsPrivateBrowsing));
  }

  // Service is disabled, throw with empty array.
  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  // Check which cookie banner service mode applies for this request. This
  // depends on whether the browser is in private browsing or normal browsing
  // mode.
  uint32_t mode;
  if (aIsPrivateBrowsing) {
    mode = StaticPrefs::cookiebanners_service_mode_privateBrowsing();
  } else {
    mode = StaticPrefs::cookiebanners_service_mode();
  }
  MOZ_LOG(
      gCookieBannerLog, LogLevel::Debug,
      ("%s. Found nsICookieBannerRule. Computed mode: %d", __FUNCTION__, mode));

  // We don't need to check the domain preference if the cookie banner handling
  // service is disabled by pref.
  if (mode != nsICookieBannerService::MODE_DISABLED &&
      mode != nsICookieBannerService::MODE_DETECT_ONLY) {
    // Get the domain preference for the uri, the domain preference takes
    // precedence over the pref setting. Note that the domain preference is
    // supposed to stored only for top level URIs.
    nsICookieBannerService::Modes domainPref;
    nsresult rv = GetDomainPref(aURI, aIsPrivateBrowsing, &domainPref);
    NS_ENSURE_SUCCESS(rv, rv);

    if (domainPref != nsICookieBannerService::MODE_UNSET) {
      mode = domainPref;
    }
  }

  // Service is disabled for current context (normal, private browsing or domain
  // preference), return empty array. Same for detect-only mode where no cookies
  // should be injected.
  if (mode == nsICookieBannerService::MODE_DISABLED ||
      mode == nsICookieBannerService::MODE_DETECT_ONLY) {
    MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
            ("%s. Returning empty array. Got MODE_DISABLED for "
             "aIsPrivateBrowsing: %d.",
             __FUNCTION__, aIsPrivateBrowsing));
    return NS_OK;
  }

  nsCOMPtr<nsICookieBannerRule> rule;
  nsresult rv = GetRuleForURI(aURI, getter_AddRefs(rule));
  NS_ENSURE_SUCCESS(rv, rv);

  if (!rule) {
    MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
            ("%s. Returning empty array. No nsICookieBannerRule matching URI.",
             __FUNCTION__));
    return NS_OK;
  }

  // MODE_REJECT: In this mode we only handle the banner if we can reject. We
  // don't care about the opt-in cookies.
  rv = rule->GetCookiesOptOut(aCookies);
  NS_ENSURE_SUCCESS(rv, rv);

  // MODE_REJECT_OR_ACCEPT: In this mode we will try to opt-out, but if we don't
  // have any opt-out cookies we will fallback to the opt-in cookies.
  if (mode == nsICookieBannerService::MODE_REJECT_OR_ACCEPT &&
      aCookies.IsEmpty()) {
    MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
            ("%s. Returning opt-in cookies.", __FUNCTION__));

    return rule->GetCookiesOptIn(aCookies);
  }

  MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
          ("%s. Returning opt-out cookies.", __FUNCTION__));

  return NS_OK;
}

NS_IMETHODIMP
nsCookieBannerService::GetClickRulesForDomain(
    const nsACString& aDomain, const bool aIsTopLevel,
    nsTArray<RefPtr<nsIClickRule>>& aRules) {
  aRules.Clear();

  // Service is disabled, throw with empty rule.
  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsCOMPtr<nsICookieBannerRule> ruleForDomain;
  nsresult rv = GetRuleForDomain(aDomain, getter_AddRefs(ruleForDomain));
  NS_ENSURE_SUCCESS(rv, rv);

  // Extract click rule from an nsICookieBannerRule and if found append it to
  // the array returned.
  auto appendClickRule = [&](const nsCOMPtr<nsICookieBannerRule>& bannerRule) {
    nsCOMPtr<nsIClickRule> clickRule;
    rv = bannerRule->GetClickRule(getter_AddRefs(clickRule));
    NS_ENSURE_SUCCESS(rv, rv);

    if (!clickRule) {
      return NS_OK;
    }

    // Evaluate the rule's runContext field and skip it if the caller's context
    // doesn't match. See nsIClickRule::RunContext for possible values.
    nsIClickRule::RunContext runContext;
    rv = clickRule->GetRunContext(&runContext);
    NS_ENSURE_SUCCESS(rv, rv);

    bool runContextMatchesRule =
        (runContext == nsIClickRule::RUN_ALL) ||
        (runContext == nsIClickRule::RUN_TOP && aIsTopLevel) ||
        (runContext == nsIClickRule::RUN_CHILD && !aIsTopLevel);

    if (runContextMatchesRule) {
      aRules.AppendElement(clickRule);
    }

    return NS_OK;
  };

  // If there is a domain-specific rule it takes precedence over the global
  // rules.
  if (ruleForDomain) {
    return appendClickRule(ruleForDomain);
  }

  if (!StaticPrefs::cookiebanners_service_enableGlobalRules()) {
    // Global rules are disabled, skip adding them.
    return NS_OK;
  }

  // Append all global click rules.
  for (nsICookieBannerRule* globalRule : mGlobalRules.Values()) {
    rv = appendClickRule(globalRule);
    NS_ENSURE_SUCCESS(rv, rv);
  }

  return NS_OK;
}

NS_IMETHODIMP
nsCookieBannerService::InsertRule(nsICookieBannerRule* aRule) {
  NS_ENSURE_ARG_POINTER(aRule);

  // Service is disabled, throw.
  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsAutoCString domain;
  nsresult rv = aRule->GetDomain(domain);
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(!domain.IsEmpty(), NS_ERROR_FAILURE);

  MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
          ("%s. domain: %s", __FUNCTION__, domain.get()));

  // Global rules are stored in a separate map mGlobalRules.
  // They are identified by a "*" in the domain field.
  // They are keyed by the unique ID field.
  if (domain.EqualsLiteral("*")) {
    nsAutoCString id;
    rv = aRule->GetId(id);
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(!id.IsEmpty(), NS_ERROR_FAILURE);

    // Global rules must not have cookies. We shouldn't set cookies for every
    // site without indication that they handle banners. Click rules are
    // different, because they have a "presence" indicator and only click if it
    // is reasonable to do so.
    rv = aRule->ClearCookies();
    NS_ENSURE_SUCCESS(rv, rv);

    nsCOMPtr<nsICookieBannerRule> result =
        mGlobalRules.InsertOrUpdate(id, aRule);
    NS_ENSURE_TRUE(result, NS_ERROR_FAILURE);

    return NS_OK;
  }

  nsCOMPtr<nsICookieBannerRule> result = mRules.InsertOrUpdate(domain, aRule);
  NS_ENSURE_TRUE(result, NS_ERROR_FAILURE);

  return NS_OK;
}

NS_IMETHODIMP
nsCookieBannerService::RemoveRule(nsICookieBannerRule* aRule) {
  NS_ENSURE_ARG_POINTER(aRule);

  // Service is disabled, throw.
  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsAutoCString domain;
  nsresult rv = aRule->GetDomain(domain);
  NS_ENSURE_SUCCESS(rv, rv);
  NS_ENSURE_TRUE(!domain.IsEmpty(), NS_ERROR_FAILURE);

  // Remove global rule by ID.
  if (domain.EqualsLiteral("*")) {
    nsAutoCString id;
    rv = aRule->GetId(id);
    NS_ENSURE_SUCCESS(rv, rv);
    NS_ENSURE_TRUE(!id.IsEmpty(), NS_ERROR_FAILURE);

    MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
            ("%s. Global Rule, id: %s", __FUNCTION__,
             PromiseFlatCString(id).get()));

    mGlobalRules.Remove(id);
    return NS_OK;
  }

  MOZ_LOG(gCookieBannerLog, LogLevel::Debug,
          ("%s. Domain rule, aDomain: %s", __FUNCTION__,
           PromiseFlatCString(domain).get()));

  // Remove site specific rule by domain.
  mRules.Remove(domain);
  return NS_OK;
}

NS_IMETHODIMP
nsCookieBannerService::GetDomainPref(nsIURI* aTopLevelURI,
                                     const bool aIsPrivate,
                                     nsICookieBannerService::Modes* aModes) {
  NS_ENSURE_ARG_POINTER(aTopLevelURI);

  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsresult rv;
  nsCOMPtr<nsIEffectiveTLDService> eTLDService(
      do_GetService(NS_EFFECTIVETLDSERVICE_CONTRACTID, &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString baseDomain;
  rv = eTLDService->GetBaseDomain(aTopLevelURI, 0, baseDomain);
  NS_ENSURE_SUCCESS(rv, rv);

  auto pref = mDomainPrefService->GetPref(baseDomain, aIsPrivate);

  *aModes = nsICookieBannerService::MODE_UNSET;

  if (pref.isSome()) {
    *aModes = pref.value();
  }

  return NS_OK;
}

NS_IMETHODIMP
nsCookieBannerService::SetDomainPref(nsIURI* aTopLevelURI,
                                     nsICookieBannerService::Modes aModes,
                                     const bool aIsPrivate) {
  NS_ENSURE_ARG_POINTER(aTopLevelURI);

  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsresult rv;
  nsCOMPtr<nsIEffectiveTLDService> eTLDService(
      do_GetService(NS_EFFECTIVETLDSERVICE_CONTRACTID, &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString baseDomain;
  rv = eTLDService->GetBaseDomain(aTopLevelURI, 0, baseDomain);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = mDomainPrefService->SetPref(baseDomain, aModes, aIsPrivate);
  NS_ENSURE_SUCCESS(rv, rv);

  return NS_OK;
}

NS_IMETHODIMP
nsCookieBannerService::RemoveDomainPref(nsIURI* aTopLevelURI,
                                        const bool aIsPrivate) {
  NS_ENSURE_ARG_POINTER(aTopLevelURI);

  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsresult rv;
  nsCOMPtr<nsIEffectiveTLDService> eTLDService(
      do_GetService(NS_EFFECTIVETLDSERVICE_CONTRACTID, &rv));
  NS_ENSURE_SUCCESS(rv, rv);

  nsCString baseDomain;
  rv = eTLDService->GetBaseDomain(aTopLevelURI, 0, baseDomain);
  NS_ENSURE_SUCCESS(rv, rv);

  rv = mDomainPrefService->RemovePref(baseDomain, aIsPrivate);
  NS_ENSURE_SUCCESS(rv, rv);

  return NS_OK;
}

NS_IMETHODIMP
nsCookieBannerService::RemoveAllDomainPrefs(const bool aIsPrivate) {
  if (!mIsInitialized) {
    return NS_ERROR_NOT_AVAILABLE;
  }

  nsresult rv = mDomainPrefService->RemoveAll(aIsPrivate);
  NS_ENSURE_SUCCESS(rv, rv);

  return NS_OK;
}

void nsCookieBannerService::DailyReportTelemetry() {
  MOZ_ASSERT(NS_IsMainThread());

  // Convert modes to strings
  uint32_t mode = StaticPrefs::cookiebanners_service_mode();
  uint32_t modePBM = StaticPrefs::cookiebanners_service_mode_privateBrowsing();

  nsCString modeStr = ConvertModeToStringForTelemetry(mode);
  nsCString modePBMStr = ConvertModeToStringForTelemetry(modePBM);

  nsTArray<nsCString> serviceModeLabels = {
      "disabled"_ns,    "reject"_ns,  "reject_or_accept"_ns,
      "detect_only"_ns, "invalid"_ns,
  };

  // Record the service mode glean.
  for (const auto& label : serviceModeLabels) {
    glean::cookie_banners::normal_window_service_mode.Get(label).Set(
        modeStr.Equals(label));
    glean::cookie_banners::private_window_service_mode.Get(label).Set(
        modePBMStr.Equals(label));
  }
}

}  // namespace mozilla
