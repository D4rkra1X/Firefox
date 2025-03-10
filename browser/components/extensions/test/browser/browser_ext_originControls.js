"use strict";

const { ExtensionPermissions } = ChromeUtils.import(
  "resource://gre/modules/ExtensionPermissions.jsm"
);

loadTestSubscript("head_unified_extensions.js");

let win;

add_setup(async () => {
  await SpecialPowers.pushPrefEnv({
    set: [["extensions.manifestV3.enabled", true]],
  });

  win = await promiseEnableUnifiedExtensions();
  registerCleanupFunction(async () => {
    await BrowserTestUtils.closeWindow(win);
  });
});

async function makeExtension({
  manifest_version = 3,
  id,
  permissions,
  host_permissions,
  content_scripts,
  granted,
}) {
  info(
    `Loading extension ` +
      JSON.stringify({ id, permissions, host_permissions, granted })
  );

  let manifest = {
    manifest_version,
    browser_specific_settings: { gecko: { id } },
    permissions,
    host_permissions,
    content_scripts,
    action: {
      default_popup: "popup.html",
      default_area: "navbar",
    },
  };
  if (manifest_version < 3) {
    manifest.browser_action = manifest.action;
    delete manifest.action;
  }

  let ext = ExtensionTestUtils.loadExtension({
    manifest,

    useAddonManager: "temporary",

    background() {
      browser.permissions.onAdded.addListener(({ origins }) => {
        browser.test.sendMessage("granted", origins.join());
      });
      browser.permissions.onRemoved.addListener(({ origins }) => {
        browser.test.sendMessage("revoked", origins.join());
      });
    },

    files: {
      "popup.html": `<!DOCTYPE html><meta charset=utf-8>Test Popup`,
    },
  });

  if (granted) {
    info("Granting initial permissions.");
    await ExtensionPermissions.add(id, { permissions: [], origins: granted });
  }

  await ext.startup();
  return ext;
}

async function testOriginControls(
  extension,
  { win, contextMenuId },
  { items, selected, click, granted, revoked, attention }
) {
  info(
    `Testing ${extension.id} on ${win.gBrowser.currentURI.spec} with contextMenuId=${contextMenuId}.`
  );

  let buttonOrWidget;
  let menu;
  let nextMenuItemClassName;

  switch (contextMenuId) {
    case "toolbar-context-menu":
      let target = `#${CSS.escape(makeWidgetId(extension.id))}-BAP`;
      buttonOrWidget = win.document.querySelector(target).parentElement;
      menu = await openChromeContextMenu(contextMenuId, target, win);
      nextMenuItemClassName = "customize-context-manageExtension";
      break;

    case "unified-extensions-context-menu":
      await openExtensionsPanel(win);
      buttonOrWidget = getUnifiedExtensionsItem(win, extension.id);
      menu = await openUnifiedExtensionsContextMenu(win, extension.id);
      nextMenuItemClassName = "unified-extensions-context-menu-pin-to-toolbar";
      break;

    default:
      throw new Error(`unexpected context menu "${contextMenuId}"`);
  }

  let doc = menu.ownerDocument;
  let visibleOriginItems = menu.querySelectorAll(
    ":is(menuitem, menuseparator):not([hidden])"
  );

  info("Check expected menu items.");
  for (let i = 0; i < items.length; i++) {
    let l10n = doc.l10n.getAttributes(visibleOriginItems[i]);
    Assert.deepEqual(
      l10n,
      items[i],
      `Visible menu item ${i} has correct l10n attrs.`
    );

    let checked = visibleOriginItems[i].getAttribute("checked") === "true";
    is(i === selected, checked, `Expected checked value for item ${i}.`);
  }

  if (items.length) {
    is(
      visibleOriginItems[items.length].nodeName,
      "menuseparator",
      "Found separator."
    );
    is(
      visibleOriginItems[items.length + 1].className,
      nextMenuItemClassName,
      "All items accounted for."
    );
  }

  is(
    buttonOrWidget.hasAttribute("attention"),
    !!attention,
    "Expected attention badge before clicking."
  );

  Assert.deepEqual(
    win.document.l10n.getAttributes(
      buttonOrWidget.querySelector(".unified-extensions-item-action-button")
    ),
    {
      id: attention
        ? "origin-controls-toolbar-button-permission-needed"
        : "origin-controls-toolbar-button",
      args: {
        extensionTitle: "Generated extension",
      },
    },
    "Correct l10n message."
  );

  let itemToClick;
  if (click) {
    itemToClick = visibleOriginItems[click];
  }

  // Clicking a menu item of the unified extensions context menu should close
  // the unified extensions panel automatically.
  let panelHidden =
    itemToClick && contextMenuId === "unified-extensions-context-menu"
      ? BrowserTestUtils.waitForEvent(win.document, "popuphidden", true)
      : Promise.resolve();

  await closeChromeContextMenu(contextMenuId, itemToClick, win);
  await panelHidden;

  // When there is no menu item to close, we should manually close the unified
  // extensions panel because simply closing the context menu will not close
  // it.
  if (!itemToClick && contextMenuId === "unified-extensions-context-menu") {
    await closeExtensionsPanel(win);
  }

  if (granted) {
    info("Waiting for the permissions.onAdded event.");
    let host = await extension.awaitMessage("granted");
    is(host, granted.join(), "Expected host permission granted.");
  }
  if (revoked) {
    info("Waiting for the permissions.onRemoved event.");
    let host = await extension.awaitMessage("revoked");
    is(host, revoked.join(), "Expected host permission revoked.");
  }
}

// Move the widget to the toolbar or the addons panel (if Unified Extensions
// is enabled) or the overflow panel otherwise.
function moveWidget(ext, win, pinToToolbar = false) {
  let overflowPanelArea = win.gUnifiedExtensions.isEnabled
    ? CustomizableUI.AREA_ADDONS
    : CustomizableUI.AREA_FIXED_OVERFLOW_PANEL;
  let area = pinToToolbar ? CustomizableUI.AREA_NAVBAR : overflowPanelArea;
  let widgetId = `${makeWidgetId(ext.id)}-browser-action`;
  CustomizableUI.addWidgetToArea(widgetId, area);
}

const originControlsInContextMenu = async options => {
  // Has no permissions.
  let ext1 = await makeExtension({ id: "ext1@test" });

  // Has activeTab and (ungranted) example.com permissions.
  let ext2 = await makeExtension({
    id: "ext2@test",
    permissions: ["activeTab"],
    host_permissions: ["*://example.com/*"],
  });

  // Has ungranted <all_urls>, and granted example.com.
  let ext3 = await makeExtension({
    id: "ext3@test",
    host_permissions: ["<all_urls>"],
    granted: ["*://example.com/*"],
  });

  // Has granted <all_urls>.
  let ext4 = await makeExtension({
    id: "ext4@test",
    host_permissions: ["<all_urls>"],
    granted: ["<all_urls>"],
  });

  // MV2 extension with an <all_urls> content script and activeTab.
  let ext5 = await makeExtension({
    manifest_version: 2,
    id: "ext5@test",
    permissions: ["activeTab"],
    content_scripts: [
      {
        matches: ["<all_urls>"],
        css: [],
      },
    ],
  });

  let extensions = [ext1, ext2, ext3, ext4, ext5];

  let unifiedButton;
  if (options.contextMenuId === "unified-extensions-context-menu") {
    // Unified button should only show a notification indicator when extensions
    // asking for attention are not already visible in the toolbar.
    moveWidget(ext1, options.win, false);
    moveWidget(ext2, options.win, false);
    moveWidget(ext3, options.win, false);
    moveWidget(ext4, options.win, false);
    moveWidget(ext5, options.win, false);
    unifiedButton = options.win.document.querySelector(
      "#unified-extensions-button"
    );
  } else {
    // TestVerify runs this again in the same Firefox instance, so move the
    // widgets back to the toolbar for testing outside the unified extensions
    // panel.
    moveWidget(ext1, options.win, true);
    moveWidget(ext2, options.win, true);
    moveWidget(ext3, options.win, true);
    moveWidget(ext4, options.win, true);
    moveWidget(ext5, options.win, true);
  }

  const NO_ACCESS = { id: "origin-controls-no-access", args: null };
  const ACCESS_OPTIONS = { id: "origin-controls-options", args: null };
  const ALL_SITES = { id: "origin-controls-option-all-domains", args: null };
  const WHEN_CLICKED = {
    id: "origin-controls-option-when-clicked",
    args: null,
  };

  const UNIFIED_NO_ATTENTION = { id: "unified-extensions-button", args: null };
  const UNIFIED_ATTENTION = {
    id: "unified-extensions-button-permissions-needed",
    args: null,
  };

  await BrowserTestUtils.withNewTab("about:blank", async () => {
    await testOriginControls(ext1, options, { items: [NO_ACCESS] });
    await testOriginControls(ext2, options, { items: [NO_ACCESS] });
    await testOriginControls(ext3, options, { items: [NO_ACCESS] });
    await testOriginControls(ext4, options, { items: [NO_ACCESS] });
    await testOriginControls(ext5, options, { items: [] });

    if (unifiedButton) {
      ok(
        !unifiedButton.hasAttribute("attention"),
        "No extension will have attention indicator on about:blank."
      );
      Assert.deepEqual(
        options.win.document.l10n.getAttributes(unifiedButton),
        UNIFIED_NO_ATTENTION,
        "Unified button has no permissions needed tooltip."
      );
    }
  });

  await BrowserTestUtils.withNewTab("http://mochi.test:8888/", async () => {
    const ALWAYS_ON = {
      id: "origin-controls-option-always-on",
      args: { domain: "mochi.test" },
    };

    await testOriginControls(ext1, options, { items: [NO_ACCESS] });

    // Has activeTab.
    await testOriginControls(ext2, options, {
      items: [ACCESS_OPTIONS, WHEN_CLICKED],
      selected: 1,
      attention: true,
    });

    // Could access mochi.test when clicked.
    await testOriginControls(ext3, options, {
      items: [ACCESS_OPTIONS, WHEN_CLICKED, ALWAYS_ON],
      selected: 1,
      attention: true,
    });

    // Has <all_urls> granted.
    await testOriginControls(ext4, options, {
      items: [ACCESS_OPTIONS, ALL_SITES],
      selected: 1,
      attention: false,
    });

    // MV2 extension, has no origin controls, and never flags for attention.
    await testOriginControls(ext5, options, { items: [], attention: false });
    if (unifiedButton) {
      ok(
        unifiedButton.hasAttribute("attention"),
        "Both ext2 and ext3 are WHEN_CLICKED for example.com, so show attention indicator."
      );
      Assert.deepEqual(
        options.win.document.l10n.getAttributes(unifiedButton),
        UNIFIED_ATTENTION,
        "UEB has permissions needed tooltip."
      );
    }
  });

  await BrowserTestUtils.withNewTab("http://example.com/", async () => {
    const ALWAYS_ON = {
      id: "origin-controls-option-always-on",
      args: { domain: "example.com" },
    };

    await testOriginControls(ext1, options, { items: [NO_ACCESS] });

    // Click alraedy selected options, expect no permission changes.
    await testOriginControls(ext2, options, {
      items: [ACCESS_OPTIONS, WHEN_CLICKED, ALWAYS_ON],
      selected: 1,
      click: 1,
      attention: true,
    });
    await testOriginControls(ext3, options, {
      items: [ACCESS_OPTIONS, WHEN_CLICKED, ALWAYS_ON],
      selected: 2,
      click: 2,
      attention: false,
    });
    await testOriginControls(ext4, options, {
      items: [ACCESS_OPTIONS, ALL_SITES],
      selected: 1,
      click: 1,
      attention: false,
    });

    await testOriginControls(ext5, options, { items: [], attention: false });

    if (unifiedButton) {
      ok(
        unifiedButton.hasAttribute("attention"),
        "ext2 is WHEN_CLICKED for example.com, show attention indicator."
      );
      Assert.deepEqual(
        options.win.document.l10n.getAttributes(unifiedButton),
        UNIFIED_ATTENTION,
        "UEB attention for only one extension."
      );
    }

    // Click the other option, expect example.com permission granted/revoked.
    await testOriginControls(ext2, options, {
      items: [ACCESS_OPTIONS, WHEN_CLICKED, ALWAYS_ON],
      selected: 1,
      click: 2,
      granted: ["*://example.com/*"],
      attention: true,
    });
    if (unifiedButton) {
      ok(
        !unifiedButton.hasAttribute("attention"),
        "Bot ext2 and ext3 are ALWAYS_ON for example.com, so no attention indicator."
      );
      Assert.deepEqual(
        options.win.document.l10n.getAttributes(unifiedButton),
        UNIFIED_NO_ATTENTION,
        "Unified button has no permissions needed tooltip."
      );
    }

    await testOriginControls(ext3, options, {
      items: [ACCESS_OPTIONS, WHEN_CLICKED, ALWAYS_ON],
      selected: 2,
      click: 1,
      revoked: ["*://example.com/*"],
      attention: false,
    });
    if (unifiedButton) {
      ok(
        unifiedButton.hasAttribute("attention"),
        "ext3 is now WHEN_CLICKED for example.com, show attention indicator."
      );
      Assert.deepEqual(
        options.win.document.l10n.getAttributes(unifiedButton),
        UNIFIED_ATTENTION,
        "UEB attention for only one extension."
      );
    }

    // Other option is now selected.
    await testOriginControls(ext2, options, {
      items: [ACCESS_OPTIONS, WHEN_CLICKED, ALWAYS_ON],
      selected: 2,
      attention: false,
    });
    await testOriginControls(ext3, options, {
      items: [ACCESS_OPTIONS, WHEN_CLICKED, ALWAYS_ON],
      selected: 1,
      attention: true,
    });

    if (unifiedButton) {
      ok(
        unifiedButton.hasAttribute("attention"),
        "Still showing the attention indicator."
      );
      Assert.deepEqual(
        options.win.document.l10n.getAttributes(unifiedButton),
        UNIFIED_ATTENTION,
        "UEB attention for only one extension."
      );
    }
  });

  await Promise.all(extensions.map(e => e.unload()));
};

add_task(async function originControls_in_browserAction_contextMenu() {
  await originControlsInContextMenu({
    win,
    contextMenuId: "toolbar-context-menu",
  });
});

add_task(async function originControls_in_unifiedExtensions_contextMenu() {
  await originControlsInContextMenu({
    win,
    contextMenuId: "unified-extensions-context-menu",
  });
});
