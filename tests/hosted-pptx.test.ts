import test from 'node:test';
import assert from 'node:assert/strict';
import { svgDataUrl } from '../web/hosted/pptx-renderer';

test('an SVG reaches PptxGenJS as a URL that an image can load', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><title>工程図</title></svg>';
  const response = await fetch(svgDataUrl(svg));
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.equal(await response.text(), svg);
});
