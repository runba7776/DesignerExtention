# Windows / PowerPoint bridge

The renderer runs in an STA .NET Framework process and accepts only the bounded scene data in `shared/contracts.ts`. It creates editable PowerPoint text, shapes, charts with an embedded Excel workbook, real SmartArt, speaker notes, and slide PNGs exported by PowerPoint itself. It never executes generated code or macros.

## Build

```powershell
./native/Build-Native.ps1
./native/bin/DesignerExtension.Renderer.exe --input ./native/smoke-scene.json --output ./runtime/native-smoke
```

Requires Windows, .NET Framework 4.x and desktop PowerPoint. Embedded native charts also require Excel. `Build-Native.ps1` uses the installed .NET Framework compiler and needs no NuGet packages or Office interop assemblies. All JSON input/output files use UTF-8.

Renderer CLI:

- `--input <scene.json> --output <new directory>` produces `presentation.pptx`, `slide-1.png` through `slide-N.png`, and `render-result.json`.
- `--open <presentation.pptx>` opens an existing generated deck for editing in PowerPoint.
- Exit code `0` is success; nonzero is an error. A caller must serialize rendering and enforce a timeout.

PowerPoint may share an existing process. The renderer creates and closes only its own presentation and chart workbook. It never quits PowerPoint, closes user presentations, changes global application settings, or uses the clipboard. Failed runs can leave incomplete output; callers must not publish those outputs. Existing `presentation.pptx` files are never overwritten. A missing SmartArt layout produces a visible warning and editable shape fallback, not an unreported substitution.

## Add-in registration

`Register.ps1 -Register` registers only `DesignerExtension.Connect` / `{EA8E8197-C2D4-4530-985C-F62677DAF6AC}` for the current Windows user, in the applicable 32-bit/64-bit registry views. `Register.ps1 -Unregister` removes those three owned registry keys. Registration requires user authorization in environments that protect the registry. A company policy may prohibit unsigned COM add-ins.

The add-in DLL is `native/bin/DesignerExtension.AddIn.dll`. PowerPoint loads its **Designer Extention** ribbon button on startup. The button starts the project's `Start-DesignerExtension.ps1` hidden and opens the authenticated local browser interface. For an in-PowerPoint right-side pane, the separate Office task-pane manifest is `Designer-Extention-TaskPane.xml`; setup and trust instructions are in `docs/taskpane-and-projects.md`. The Office.js task pane loads its required library from Microsoft's CDN. The COM renderer and editable PowerPoint objects remain native. No WebView2 SDK is required.

Moving the project directory requires registering the new DLL path again. Unregister before deleting or moving the old project. Company signing, managed deployment, direct insertion into the active presentation and template import remain extension points.

## Verification

Run `powershell -NoProfile -ExecutionPolicy Bypass -File native/Verify-Interop.ps1 -CheckRegistration` after registration. This checks the imported Office COM interface identities, the five `SAFEARRAY(VARIANT)*` callback parameters, ribbon XML and COM activation without launching PowerPoint. The exact array marshaling is necessary to avoid corrupting Office startup. Close PowerPoint before rebuilding a loaded add-in DLL.

The smoke fixture exercises Japanese text, native SmartArt, native chart data, notes and PowerPoint PNG export. Verify the resulting PPTX ZIP contains `ppt/diagrams/data*.xml`, `ppt/charts/chart*.xml`, `ppt/embeddings/*.xlsx` and `ppt/notesSlides/notesSlide*.xml`, and visually inspect the exported PNG. The sample values are synthetic and are not evidence for any real claim.

Some Office installations briefly return a stale embedded Excel connection between decks. The renderer bounds activation retries; the server may recreate an unsaved deck once only for recognized chart startup/disconnection errors, within the same three-minute deadline. Saved output is never overwritten, and this recovery makes no LLM calls.

`node --import tsx native/Verify-Rendering.ts` exercises two consecutive six-slide renders in both themes, using the production bridge and no API. It checks native output, warning-free completion and all twelve 1600×900 thumbnails, and reports the new artifact directories. This opt-in check requires desktop PowerPoint and Excel and can briefly bring Office windows forward.

Primary API references: [AddSmartArt](https://learn.microsoft.com/en-us/office/vba/api/powerpoint.shapes.addsmartart), [AddChart2](https://learn.microsoft.com/en-us/office/vba/api/powerpoint.shapes.addchart2), [SmartArt nodes](https://learn.microsoft.com/en-us/office/vba/api/office.smartart.allnodes).
