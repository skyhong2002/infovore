import satori from 'satori';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fontDir = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const interRegular = readFileSync(fontDir + 'Inter-Regular.ttf');
const interBold = readFileSync(fontDir + 'Inter-Bold.ttf');

// Minimal element helper — satori accepts React-shaped plain objects,
// so we skip JSX entirely.
export function h(
  type: string,
  props: Record<string, unknown> | null,
  ...children: unknown[]
): Record<string, unknown> {
  return {
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children },
  };
}

export interface Theme {
  bg: string;
  border: string;
  text: string;
  subtext: string;
  accent: string;
}

// Palettes sampled from each site's live dark UI.
export const themes: Record<string, Theme> = {
  backloggd: { bg: '#16181c', border: '#2a2e35', text: '#e8eaed', subtext: '#8a939e', accent: '#ea377a' },
  kitsu:     { bg: '#221626', border: '#3a2b3e', text: '#f5f0f5', subtext: '#a89aa8', accent: '#f75239' },
  statsfm:   { bg: '#111112', border: '#26262b', text: '#ffffff', subtext: '#9a9aa0', accent: '#1ed761' },
  simkl:     { bg: '#0f1214', border: '#232a2f', text: '#eef2f4', subtext: '#8b979e', accent: '#00b9ff' },
};

export function statBlock(
  t: Theme,
  value: string,
  label: string,
  size = 40
): Record<string, unknown> {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 } },
    h('span', { style: { fontSize: size, fontWeight: 700, color: t.text } }, value),
    h(
      'span',
      { style: { fontSize: 14, color: t.subtext, marginTop: 4, whiteSpace: 'nowrap' } },
      label
    )
  );
}

export function cardShell(
  t: Theme,
  title: string,
  subtitle: string,
  body: Record<string, unknown>
): Record<string, unknown> {
  return h(
    'div',
    {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        backgroundColor: t.bg,
        borderRadius: 12,
        border: `1px solid ${t.border}`,
        padding: 24,
        fontFamily: 'Inter',
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginBottom: 18 } },
      h('span', { style: { fontSize: 20, fontWeight: 700, color: t.accent } }, title),
      h('span', { style: { fontSize: 13, color: t.subtext, marginLeft: 10 } }, subtitle)
    ),
    body
  );
}

export async function renderCard(
  node: Record<string, unknown>,
  width = 480,
  height = 200
): Promise<string> {
  return satori(node as never, {
    width,
    height,
    fonts: [
      { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
      { name: 'Inter', data: interBold, weight: 700, style: 'normal' },
    ],
  });
}
