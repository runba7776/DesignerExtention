// Adds an auto-opening task pane reference (developer/registry sideload) to an
// existing PPTX, for checking an add-in build in desktop PowerPoint.
//   node scripts/make-test-deck.mjs <input.pptx> <output.pptx> <addinId> <version>
import { readFile, writeFile } from 'node:fs/promises';
import JSZip from 'jszip';

const [input, output, id, version] = process.argv.slice(2);
if (!input || !output || !id || !version) throw new Error('usage: make-test-deck.mjs <input.pptx> <output.pptx> <addinId> <version>');
const zip = await JSZip.loadAsync(await readFile(input));
zip.file('ppt/webextensions/webextension1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><we:webextension xmlns:we="http://schemas.microsoft.com/office/webextensions/webextension/2010/11" id="{${id}}"><we:reference id="${id}" version="${version}" store="developer" storeType="Registry"/><we:alternateReferences/><we:properties/><we:bindings/><we:snapshot xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></we:webextension>`);
zip.file('ppt/webextensions/taskpanes.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><wetp:taskpanes xmlns:wetp="http://schemas.microsoft.com/office/webextensions/taskpanes/2010/11"><wetp:taskpane dockstate="right" visibility="1" width="420" row="1"><wetp:webextensionref xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rIdWe1"/></wetp:taskpane></wetp:taskpanes>');
zip.file('ppt/webextensions/_rels/taskpanes.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdWe1" Type="http://schemas.microsoft.com/office/2011/relationships/webextension" Target="webextension1.xml"/></Relationships>');
const rels = await zip.file('_rels/.rels').async('string');
if (!rels.includes('webextensiontaskpanes')) zip.file('_rels/.rels', rels.replace('</Relationships>', '<Relationship Id="rIdWeTp" Type="http://schemas.microsoft.com/office/2011/relationships/webextensiontaskpanes" Target="ppt/webextensions/taskpanes.xml"/></Relationships>'));
const types = await zip.file('[Content_Types].xml').async('string');
if (!types.includes('webextensiontaskpanes')) zip.file('[Content_Types].xml', types.replace('</Types>', '<Override PartName="/ppt/webextensions/taskpanes.xml" ContentType="application/vnd.ms-office.webextensiontaskpanes+xml"/><Override PartName="/ppt/webextensions/webextension1.xml" ContentType="application/vnd.ms-office.webextension+xml"/></Types>'));
await writeFile(output, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Wrote ${output}`);
