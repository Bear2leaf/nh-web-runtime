#!/usr/bin/env python3
import os
import shutil
import sys

def patch_winshim():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    if 'submodules' in script_dir:
        # Legacy: nh-web-runtime was inside NetHack's submodules/
        nethack_root = os.path.abspath(os.path.join(script_dir, '..', '..'))
    else:
        # Current: NetHack is a submodule inside nh-web-runtime/
        nethack_root = os.path.abspath(os.path.join(script_dir, 'NetHack'))
    
    input_file = os.path.join(nethack_root, "win", "shim", "winshim.c")
    backup_file = os.path.join(nethack_root, "win", "shim", "winshim.c.bak")
    
    print(f"Patching: {input_file}")

    with open(input_file, 'r') as f:
        content = f.read()

    if "shim_get_nh_event" in content and "if (name === 'shim_get_nh_event')" in content:
        print("winshim.c already patched, skipping")
        return True

    old_start = content.find('        // do the callback')
    section_end = content.find('        function getArg(name, ptr, type)', old_start)
    
    if old_start == -1 or section_end == -1:
        print("ERROR: Could not find pattern to patch")
        return False
    
    new_section = '''        // do the callback
        let userCallback = globalThis[cbName];
        if (!userCallback) {
            console.error("[NH] Callback not found: " + cbName);
            reentryMutexUnlock();
            wakeUp();
            return;
        }
        if (name === "shim_get_nh_event") {
            reentryMutexUnlock();
            wakeUp();
            return;
        }
        Promise.resolve(userCallback(name, ... jsArgs)).then((retVal) => {
            setPointerValue(name, ret_ptr, retType, retVal);
            reentryMutexUnlock();
            wakeUp();
        }).catch((err) => {
            console.error("[NH] Error: " + err);
            reentryMutexUnlock();
            wakeUp();
        });
'''

    shutil.copy(input_file, backup_file)
    print("Original backed up to", backup_file)
    
    content = content[:old_start] + new_section + content[section_end:]
    
    with open(input_file, 'w') as f:
        f.write(content)

    print("winshim.c patched successfully")
    return True

if __name__ == "__main__":
    success = patch_winshim()
    sys.exit(0 if success else 1)
