#!/bin/bash

# Print an Error message if `set -eE` causes the script to exit due to a failed command
trap 'echo "*** ERROR *** $? $LINENO $0 did not complete successfully!"' ERR

source dom/media/webrtc/third_party_build/use_config_env.sh

echo "MOZ_LIBWEBRTC_SRC: $MOZ_LIBWEBRTC_SRC"
echo "MOZ_LIBWEBRTC_COMMIT: $MOZ_LIBWEBRTC_COMMIT"
echo "MOZ_FASTFORWARD_BUG: $MOZ_FASTFORWARD_BUG"
echo "MOZ_PRIOR_GIT_BRANCH: $MOZ_PRIOR_GIT_BRANCH"

# After this point:
# * eE: All commands should succeed.
# * u: All variables should be defined before use.
# * o pipefail: All stages of all pipes should succeed.
set -eEuo pipefail

# install requests module on macOS
if [[ "Darwin" = `uname` ]]; then
  pip install --user requests
fi

python3 dom/media/webrtc/third_party_build/vendor-libwebrtc.py \
        --from-local $MOZ_LIBWEBRTC_SRC \
        --commit $MOZ_LIBWEBRTC_COMMIT \
        libwebrtc

hg revert -q \
   --include "third_party/libwebrtc/**moz.build" \
   --include "third_party/libwebrtc/README.mozilla" \
   third_party/libwebrtc

FILE_CHANGE_CNT=`hg status third_party/libwebrtc | wc -l | tr -d " "`
if [ "x$FILE_CHANGE_CNT" != "x0" ]; then
  echo "***"
  echo "There are changes after vendoring - running extract-for-git.py"
  echo "is recommended.  First, find the mercurial commit after the"
  echo "previous fast-forward landing.  The commands you want will look"
  echo "something like:"
  echo "  python3 dom/media/webrtc/third_party_build/extract-for-git.py {after-ff-commit}::{tip-of-central}"
  echo "  mv mailbox.patch $MOZ_LIBWEBRTC_SRC"
  echo "  (cd $MOZ_LIBWEBRTC_SRC && \\"
  echo "   git am mailbox.patch)"
  echo ""
  echo "After adding the new changes from moz-central to the moz-libwebrtc"
  echo "patch stack, you may re-run this command to verify vendoring:"
  echo "  $0"

  exit 1
fi


echo "Done - vendoring has been verified."
