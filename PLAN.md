# keymon: implementation plan

This plan builds keymon as described in [SPEC.md](SPEC.md), in six stages. Stop after each stage so the user can check the result on their own screen before the next one starts.

## Working rules

- **Before stage 1:** run `git init` in this folder, which isn't a repository yet.
- **One stage at a time:** start each stage in a fresh session or with a clear handoff, pointing to `SPEC.md` and naming the stage. Stop when the stage is done rather than continuing.
- **Commits:** commit after each stage, so there is a working state to return to.
- **Spec changes:** if a stage shows the spec is wrong, update `SPEC.md` in the same commit.
- **Testing:** use a nested GNOME Shell session for quick iteration where possible. Wayland GNOME Shell only loads new extension code after a logout, so say when a check needs a real login.
- **End of stage:** finish with a short list of what the user needs to test, since an agent can't do the visual checks itself.
- **Privileged files:** the user reviews `keymon.service`, `keymon.socket`, and `install.sh` before running them. They use sudo and control access to all keystrokes.

## Stages

### Stage 1: Prototype

**Deliverable:** a minimal extension with a click-through ring and a static box, plus answers to the unknowns in SPEC.md section 15.

**User checks:**
- The ring tracks the pointer smoothly.
- Clicks pass through the ring and the box.
- Both show up in GNOME's recorder and in OBS.

This stage tests the architecture itself. If something fails here, change the spec before building further.

### Stage 2: Key pipeline

**Deliverable:** the helper, systemd units, install script, and raw key codes shown on screen.

**User checks:**
- Keys appear while another app has focus.
- The service stops when keymon is toggled off.
- The user's account is still not in the `input` group.

### Stage 3: Display logic

**Deliverable:** `state.js` and its tests, with no Shell imports.

**User checks:** review the tests against SPEC.md section 7. There is nothing visual yet.

### Stage 4: Real key overlay

**Deliverable:** the keymap tool and key labels, with the state machine wired to the overlay.

**User checks:** acceptance criteria 1–9, on both the `us+altgr-intl` and `be` layouts.

### Stage 5: Mouse

**Deliverable:** click ripples, the held state, and per-button colours.

**User checks:** acceptance criteria 10–13.

### Stage 6: Finish

**Deliverable:** config reload, panel icon, shortcut, lock handling, error handling, and the uninstall script.

**User checks:** acceptance criteria 14–20.
