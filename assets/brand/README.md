# infovore — 生活年輪 / Life Rings

The selected identity is concept 4, in the owner's blue `#001483` and yellow
`#fefe7e`. `life-rings-lockup.png` preserves the selected concept. The built-in
imagegen tool derived `life-rings-icon.png` (symbol only) and
`life-rings-social.png` (landscape cover). These are raster masters; generated
pixels can vary from the requested ink values. UI brand tokens use exact hex values.

Run `node scripts/build-brand.mjs` to export the checked-in PNGs for the website,
favicon, Apple touch icon, Chrome extension, Android launcher, and 1200×630 OG
cover. The exporter only fits/resizes the masters, without cropping the mark.

The website header/footer, Chrome popup/options and Android home screen all use
the symbol. Third-party platform marks remain their respective service logos.

## Final generation prompts

Both edits referenced `../logos/infovore-concepts/04-life-rings-blue-yellow.png`.

Icon:

> Edit this selected infovore life-rings logo into a production app icon. Preserve the exact nested rounded-square life-ring symbol, including its outer upper-right yellow dot and central yellow page-like shape with blue folded corner. Remove only the wordmark below. Center the symbol alone in a square white background with 10% even safety margin. Use solid exact deep blue #001483 and yellow #fefe7e, crisp flat vector-style edges. No text, no extra elements, no shadows, no texture, no gradients. Keep the selected symbol identity and geometry.

Social cover:

> Create the social sharing cover for infovore using this exact chosen life-rings logo and lowercase infovore wordmark. Preserve their identity. Landscape 1200x630 aspect ratio. White background. Place the complete logo and wordmark centered, comfortably inside the middle 70% of canvas height, with generous white space left and right. Use the brand deep blue #001483 and yellow #fefe7e. No additional words, slogans, mockups or decoration. Flat crisp colors. This is a restrained finished Open Graph cover.
