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

export const theme = {
  bg: '#16181c',
  panel: '#1f2228',
  text: '#e8eaed',
  subtext: '#9aa0a8',
  accent: '#ea377a',
};

export function statBlock(value: string, label: string): Record<string, unknown> {
  return h(
    'div',
    { style: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 } },
    h('span', { style: { fontSize: 40, fontWeight: 700, color: theme.text } }, value),
    h('span', { style: { fontSize: 14, color: theme.subtext, marginTop: 4 } }, label)
  );
}

export function cardShell(
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
        backgroundColor: theme.bg,
        borderRadius: 12,
        border: `1px solid #2a2e35`,
        padding: 24,
        fontFamily: 'Inter',
      },
    },
    h(
      'div',
      { style: { display: 'flex', alignItems: 'baseline', marginBottom: 18 } },
      h('span', { style: { fontSize: 20, fontWeight: 700, color: theme.accent } }, title),
      h('span', { style: { fontSize: 13, color: theme.subtext, marginLeft: 10 } }, subtitle)
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
