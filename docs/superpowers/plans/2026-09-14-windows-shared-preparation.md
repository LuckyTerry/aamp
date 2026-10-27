# Windows shared foreground preparation

Approved scope: Windows install, start and add share interactive preparation;
macOS and foreground install/start retain existing behavior.

1. Add regression coverage for Windows install deferring all Bridge launches to
   the background start path, including partial selections and cancellation.
2. Add an explicit deferred-launch option to binding collection. Windows
   background install delegates saved bindings to the existing prepared start
   path. Keep initial pairing and saved-runtime validation in the worker.
3. Prepare added bindings inside the serialized activation transaction before
   touching the previous service. Preserve selection merge and activation
   rollback. Preparation failure restores replaced bindings without restarting
   an untouched service; no-start and legacy foreground paths skip preparation.
4. Run startup, pairing, activation, Windows worker/service and package tests.
   Do not restart real Bots. Update documentation, commit, rebase and push.
