"""Builds the website's handwriting font, website/assets/fonts/xiaoji-hand.woff2.

The font is a subset of 辰宇落雁體 (ChenYuluoyan 2.0 Thin, SIL Open Font License 1.1) holding only the characters
the website's own files use; anything else (an AI support answer, say) falls back to Noto Sans TC. The licence
reserves the names "辰宇落雁" and "Chenyuluoyan", and a subset is a Modified Version, so the subset is renamed
"Xiaoji Hand". website/assets/fonts/OFL.txt carries the copyright notice and the licence.

  pip install -r scripts/requirements-site-font.txt
  python scripts/build-site-font.py --source ChenYuluoyan-2.0-Thin.ttf

Download the source from https://github.com/Chenyu-otf/chenyuluoyan_thin/releases/tag/v2.0. The script checks
its SHA-256, writes the font and website/assets/fonts/xiaoji-hand.chars.txt (the website characters the build
considered, which test/siteFont.test.js compares with the website's text). Run it again whenever the website gains
characters the font does not cover.
"""
import argparse
import hashlib
import pathlib

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE_SHA256 = '1289e42a6d1ec995d0cb23aee89efc69fc95749fbd54a610057a3e992dc453db'
FONT_PATH = ROOT / 'website' / 'assets' / 'fonts' / 'xiaoji-hand.woff2'
CHARS_PATH = ROOT / 'website' / 'assets' / 'fonts' / 'xiaoji-hand.chars.txt'
TEXT_SUFFIXES = {'.html', '.js', '.css'}
EXTRA = '　、。，．：；？！「」『』（）《》〈〉…—～・％＋－＝／０１２３４５６７８９'


def website_characters():
    chars = {chr(code) for code in range(0x20, 0x7F)} | set(EXTRA)
    for path in sorted((ROOT / 'website').rglob('*')):
        if path.suffix in TEXT_SUFFIXES and path.is_file() and 'games' not in path.relative_to(ROOT / 'website').parts:
            chars |= set(path.read_text(encoding='utf-8'))
    return {char for char in chars if ord(char) >= 0x20}


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--source', required=True, help='ChenYuluoyan-2.0-Thin.ttf')
    args = parser.parse_args()
    data = pathlib.Path(args.source).read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(f'{args.source} is not ChenYuluoyan 2.0 Thin (sha256 {digest}).')
    font = TTFont(args.source)
    cmap = font.getBestCmap()
    covered = sorted(char for char in website_characters() if ord(char) in cmap)
    options = subset.Options()
    options.flavor = 'woff2'
    options.layout_features = ['*']
    options.name_IDs = ['*']
    options.notdef_outline = True
    subsetter = subset.Subsetter(options)
    subsetter.populate(unicodes=[ord(char) for char in covered])
    subsetter.subset(font)
    for record in font['name'].names:
        if record.nameID in (1, 4, 16, 21):
            record.string = 'Xiaoji Hand'
        elif record.nameID == 6:
            record.string = 'XiaojiHand-Thin'
        elif record.nameID == 3:
            record.string = 'XiaojiHand-Thin-website-subset'
    font.flavor = 'woff2'
    font.save(FONT_PATH)
    # Every character the build considered, the ones the source font lacks included (those stay in Noto Sans TC).
    considered = sorted(website_characters())
    CHARS_PATH.write_text(''.join(considered), encoding='utf-8')
    print(f'Wrote {FONT_PATH.relative_to(ROOT)} ({FONT_PATH.stat().st_size // 1024} KB, {len(covered)} characters).')


if __name__ == '__main__':
    main()
