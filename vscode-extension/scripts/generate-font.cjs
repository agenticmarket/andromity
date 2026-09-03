const fs = require('fs');
const path = require('path');
const { SVGIcons2SVGFontStream } = require('svgicons2svgfont');
const svg2ttf = require('svg2ttf');
const ttf2woff = require('ttf2woff');

const fontStream = new SVGIcons2SVGFontStream({
  fontName: 'andromity-icons',
  normalize: true,
  fontHeight: 1000,
});

const svgPath = path.resolve(__dirname, '../media/sidebar-icon.svg');
const glyph = fs.createReadStream(svgPath);
glyph.metadata = {
  unicode: ['\uE001'],
  name: 'andromity-logo',
};

let svgFontBuffer = '';
fontStream.on('data', (chunk) => {
  svgFontBuffer += chunk.toString();
});

fontStream.on('end', () => {
  const ttf = svg2ttf(svgFontBuffer, {});
  const woff = ttf2woff(new Uint8Array(ttf.buffer));
  const outPath = path.resolve(__dirname, '../media/andromity-font.woff');
  fs.writeFileSync(outPath, Buffer.from(woff.buffer));
  console.log('Successfully generated WOFF font at:', outPath);
});

fontStream.on('error', (err) => {
  console.error('Error generating font:', err);
});

fontStream.write(glyph);
fontStream.end();
