"use strict";

var { MigrationUtils, MigratorPrototype } = ChromeUtils.importESModule(
  "resource:///modules/MigrationUtils.sys.mjs"
);
var { LoginHelper } = ChromeUtils.import(
  "resource://gre/modules/LoginHelper.jsm"
);
var { NetUtil } = ChromeUtils.import("resource://gre/modules/NetUtil.jsm");
var { PlacesUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PlacesUtils.sys.mjs"
);
var { Preferences } = ChromeUtils.importESModule(
  "resource://gre/modules/Preferences.sys.mjs"
);
var { PromiseUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/PromiseUtils.sys.mjs"
);
var { XPCOMUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/XPCOMUtils.sys.mjs"
);
var { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);
var { PlacesTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/PlacesTestUtils.sys.mjs"
);

ChromeUtils.defineESModuleGetters(this, {
  FileUtils: "resource://gre/modules/FileUtils.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
});

// Initialize profile.
var gProfD = do_get_profile();

var { getAppInfo, newAppInfo, updateAppInfo } = ChromeUtils.importESModule(
  "resource://testing-common/AppInfo.sys.mjs"
);
updateAppInfo();

/**
 * Migrates the requested resource and waits for the migration to be complete.
 */
async function promiseMigration(
  migrator,
  resourceType,
  aProfile = null,
  succeeds = null
) {
  // Ensure resource migration is available.
  let availableSources = await migrator.getMigrateData(aProfile);
  Assert.ok(
    (availableSources & resourceType) > 0,
    "Resource supported by migrator"
  );
  let promises = [TestUtils.topicObserved("Migration:Ended")];

  if (succeeds !== null) {
    // Check that the specific resource type succeeded
    promises.push(
      TestUtils.topicObserved(
        succeeds ? "Migration:ItemAfterMigrate" : "Migration:ItemError",
        (_, data) => data == resourceType
      )
    );
  }

  // Start the migration.
  migrator.migrate(resourceType, null, aProfile);

  return Promise.all(promises);
}

/**
 * Replaces a directory service entry with a given nsIFile.
 */
function registerFakePath(key, file) {
  let dirsvc = Services.dirsvc.QueryInterface(Ci.nsIProperties);
  let originalFile;
  try {
    // If a file is already provided save it and undefine, otherwise set will
    // throw for persistent entries (ones that are cached).
    originalFile = dirsvc.get(key, Ci.nsIFile);
    dirsvc.undefine(key);
  } catch (e) {
    // dirsvc.get will throw if nothing provides for the key and dirsvc.undefine
    // will throw if it's not a persistent entry, in either case we don't want
    // to set the original file in cleanup.
    originalFile = undefined;
  }

  dirsvc.set(key, file);
  registerCleanupFunction(() => {
    dirsvc.undefine(key);
    if (originalFile) {
      dirsvc.set(key, originalFile);
    }
  });
}
