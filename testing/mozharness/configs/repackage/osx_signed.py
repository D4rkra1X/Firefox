# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.

import os

config = {
    "src_mozconfig": "browser/config/mozconfigs/macosx64/repack",
    "locale": os.environ.get("LOCALE"),
    # ToolTool
    "tooltool_cache": os.environ.get("TOOLTOOL_CACHE"),
    # TODO: `create_pkg` doesn't require this.
    #       We need to refactor `create_dmg` to remove this requirement
    "run_configure": True,
}
