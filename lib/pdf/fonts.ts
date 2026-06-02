import path from 'node:path';
import { Font } from '@react-pdf/renderer';

let registered = false;

function fontPath(fileName: string) {
  return path.join(process.cwd(), 'lib', 'pdf', 'fonts', fileName);
}

export function registerPdfFonts() {
  if (registered) {
    return;
  }

  Font.register({
    family: 'Geist',
    fonts: [
      { src: fontPath('Geist-Regular.ttf'), fontWeight: 400 },
      { src: fontPath('Geist-SemiBold.ttf'), fontWeight: 600 },
      { src: fontPath('Geist-Bold.ttf'), fontWeight: 700 },
    ],
  });

  Font.register({
    family: 'Geist Mono',
    fonts: [{ src: fontPath('GeistMono-Regular.ttf'), fontWeight: 400 }],
  });

  // TODO: réintégrer PP Editorial New (titres PDF) quand la licence sera acquise
  Font.registerHyphenationCallback((word) => [word]);

  registered = true;
}
