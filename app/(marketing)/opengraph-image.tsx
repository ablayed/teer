import { ImageResponse } from 'next/og';

// Image de partage (WhatsApp / Facebook / Twitter). Générée à la build,
// auto-câblée par Next sur la route /. Crème + orange, wordmark au tréma orange.
export const runtime = 'nodejs';
export const alt =
  'Tëër — tableau de bord du paiement à la livraison pour marchands Shopify au Sénégal';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default function OpengraphImage() {
  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        background: '#f4f3ed',
        padding: '80px',
        fontFamily: 'Georgia, serif',
      }}
    >
      <div style={{ display: 'flex', fontSize: 64, letterSpacing: '-0.02em', color: '#2a2622' }}>
        <span>T</span>
        <span style={{ color: '#ee8243' }}>ë</span>
        <span style={{ color: '#ee8243' }}>ë</span>
        <span>r</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'baseline',
            columnGap: 16,
            fontSize: 68,
            lineHeight: 1.05,
            color: '#2a2622',
            maxWidth: 1000,
            letterSpacing: '-0.02em',
          }}
        >
          <span>Recevez. Confirmez.</span>
          <span style={{ color: '#a8500f', fontStyle: 'italic' }}>Livrez.</span>
          <span>Sans rien perdre.</span>
        </div>
        <div style={{ fontSize: 30, color: '#5f574d', fontFamily: 'Arial, sans-serif' }}>
          Le tableau de bord COD pour marchands Shopify au Sénégal.
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          fontSize: 26,
          fontFamily: 'Arial, sans-serif',
          color: '#2a2622',
        }}
      >
        <div
          style={{
            display: 'flex',
            background: '#ee8243',
            color: '#111111',
            padding: '12px 28px',
            borderRadius: 999,
            fontWeight: 600,
          }}
        >
          Commencer gratuitement
        </div>
        <span style={{ color: '#5f574d' }}>Sans carte bancaire</span>
      </div>
    </div>,
    { ...size },
  );
}
