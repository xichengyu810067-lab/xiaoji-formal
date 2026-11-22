"""Builds the README's pictures in docs/images/readme/: banner, chat demo, dividers, footer, icons and titles.

GitHub shows a README in its own fonts and sizes, so the README's handwriting lives in these pictures. Every
letter is drawn as a shape from 辰宇落雁體 (ChenYuluoyan 2.0 Thin, SIL Open Font License 1.1), the website's
font, so the pictures look the same on every computer. The light and dark versions follow the reader's GitHub
theme through <picture>. The titles carry their own anchors in README.md, so the table of contents still works.

  pip install -r scripts/requirements-site-font.txt
  python scripts/build-readme-art.py --source ChenYuluoyan-2.0-Thin.ttf
"""
import argparse
import hashlib
import pathlib
import random

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'docs' / 'images' / 'readme'
SOURCE_SHA256 = '1289e42a6d1ec995d0cb23aee89efc69fc95749fbd54a610057a3e992dc453db'

THEMES = {
    'light': dict(bg1='#fff7f2', bg2='#ffe4ee', bg3='#ffe9da', ink='#3a2a35', soft='#6f5867', accent='#e8789f',
                  accent2='#f19a84', mint='#3f9c80', mark_ink='#ffffff', spark='#e8789f', chat_bg='#ffffff',
                  chat_panel='#f2f3f5', chat_ink='#2e3338', chat_soft='#5c5e66', chat_user='#c25e8a',
                  chat_bubble='#fff0f5', chat_line='#e3e5e8', icon_bg='#fff7f2'),
    'dark': dict(bg1='#1f151f', bg2='#3a2133', bg3='#2a1d2a', ink='#fbeff3', soft='#d9bfcb', accent='#ff9ec4',
                 accent2='#ffc98a', mint='#7fdcbc', mark_ink='#3d2614', spark='#ffb3d1', chat_bg='#313338',
                 chat_panel='#2b2d31', chat_ink='#dbdee1', chat_soft='#949ba4', chat_user='#ffb3d1',
                 chat_bubble='#3a2f39', chat_line='#3f4147', icon_bg='#2a1d2a'),
}

# The README's picture titles: (file name, text). Sections are 48px, features 32px.
SECTION_TITLES = [('toc', '目錄'), ('new', '30 秒看懂 1.3.4 更新'), ('features', '小吉能做什麼'),
                  ('how', '小吉怎麼回你的話'), ('privacy', '隱私與安全'), ('more', '想知道更多')]
FEATURE_TITLES = [('chat', '聊天'), ('memory', '記憶'), ('stock-food', '股票與美食'), ('games', '遊戲'),
                  ('coins', '吉幣'), ('weather', '查天氣'), ('daily-topic', '每日議題'), ('reminders', '小提醒與行事曆')]


class Lettering:
    """Draws text as SVG paths from the font."""

    def __init__(self, path):
        self.font = TTFont(path)
        self.glyphs = self.font.getGlyphSet()
        self.cmap = self.font.getBestCmap()
        self.units = self.font['head'].unitsPerEm
        self.hmtx = self.font['hmtx']

    def width(self, text, size):
        return sum(self.hmtx[self.cmap[ord(char)]][0] for char in text) * size / self.units

    def path(self, text, x, y, size, fill, anchor='start', stroke=0.0, extra=''):
        missing = [char for char in text if ord(char) not in self.cmap]
        if missing:
            raise SystemExit(f'The font has no {"".join(missing)!r} (in {text!r}).')
        width = self.width(text, size)
        x0 = x - width / 2 if anchor == 'middle' else x - width if anchor == 'end' else x
        pen = SVGPathPen(self.glyphs, ntos=lambda value: str(round(value)))
        advance = 0
        for char in text:
            name = self.cmap[ord(char)]
            self.glyphs[name].draw(TransformPen(pen, (1, 0, 0, 1, advance, 0)))
            advance += self.hmtx[name][0]
        scale = size / self.units
        stroke_attr = f' stroke="{fill}" stroke-width="{stroke / scale:.0f}" stroke-linejoin="round"' if stroke else ''
        return (f'<path d="{pen.getCommands()}" transform="translate({x0:.1f} {y:.1f}) scale({scale:.5f} {-scale:.5f})" '
                f'fill="{fill}"{stroke_attr}{extra}/>')


def banner(letters, t):
    rng = random.Random(7)
    sparks = ''
    for index in range(14):
        x, r = rng.randint(40, 1160), rng.choice([2, 3, 3, 4, 5])
        duration, begin = rng.uniform(6, 12), rng.uniform(0, 8)
        color = t['spark'] if index % 3 else t['mint']
        sparks += (f'<circle cx="{x}" cy="330" r="{r}" fill="{color}" opacity="0">'
                   f'<animate attributeName="cy" from="330" to="-20" dur="{duration:.1f}s" begin="{begin:.1f}s" repeatCount="indefinite"/>'
                   f'<animate attributeName="opacity" values="0;.8;.8;0" dur="{duration:.1f}s" begin="{begin:.1f}s" repeatCount="indefinite"/></circle>')
    subtitle = 'Discord 上的聊天好朋友'
    sub_width = letters.width(subtitle, 42) + 10
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="320" viewBox="0 0 1200 320" role="img" aria-label="小吉：Discord 上的聊天好朋友">
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="{t['bg1']}"><animate attributeName="stop-color" values="{t['bg1']};{t['bg2']};{t['bg1']}" dur="10s" repeatCount="indefinite"/></stop>
<stop offset="1" stop-color="{t['bg3']}"><animate attributeName="stop-color" values="{t['bg3']};{t['bg1']};{t['bg3']}" dur="10s" repeatCount="indefinite"/></stop>
</linearGradient>
<linearGradient id="ink" gradientUnits="userSpaceOnUse" x1="420" y1="0" x2="640" y2="0">
<stop offset="0" stop-color="{t['accent']}"/><stop offset=".5" stop-color="{t['accent2']}"/><stop offset="1" stop-color="{t['accent']}"/>
<animateTransform attributeName="gradientTransform" type="translate" values="-220 0;220 0" dur="6s" repeatCount="indefinite"/>
</linearGradient>
<linearGradient id="mark" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{t['accent']}"/><stop offset="1" stop-color="{t['accent2']}"/></linearGradient>
<clipPath id="type"><rect x="420" y="180" width="0" height="70"><animate attributeName="width" values="0;{sub_width:.0f};{sub_width:.0f};0" keyTimes="0;.45;.9;1" dur="8s" repeatCount="indefinite"/></rect></clipPath>
</defs>
<rect width="1200" height="320" rx="28" fill="url(#bg)"/>
{sparks}
<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -10;0 0" dur="3.2s" repeatCount="indefinite"/>
<rect x="180" y="90" width="140" height="140" rx="38" fill="url(#mark)"/>
{letters.path('吉', 250, 192, 96, t['mark_ink'], 'middle', stroke=2.4)}
</g>
{letters.path('小吉', 420, 170, 110, 'url(#ink)', stroke=3)}
<g clip-path="url(#type)">{letters.path(subtitle, 424, 236, 42, t['ink'], stroke=1.2)}</g>
<rect x="0" y="200" width="4" height="44" fill="{t['accent']}"><animate attributeName="x" values="424;{424 + sub_width:.0f};{424 + sub_width:.0f};424" keyTimes="0;.45;.9;1" dur="8s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></rect>
{letters.path('聊天、遊戲、天氣、提醒、吉幣、股票、美食', 424, 288, 26, t['soft'], stroke=0.6)}
</svg>
'''


def divider(t):
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="24" viewBox="0 0 1200 24" aria-hidden="true">
<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="{t['accent']}" stop-opacity="0"/><stop offset=".5" stop-color="{t['accent']}"/><stop offset="1" stop-color="{t['accent2']}" stop-opacity="0"/></linearGradient></defs>
<path d="M0 12 Q 50 0 100 12 T 200 12 T 300 12 T 400 12 T 500 12 T 600 12 T 700 12 T 800 12 T 900 12 T 1000 12 T 1100 12 T 1200 12 T 1300 12 T 1400 12" fill="none" stroke="url(#g)" stroke-width="3" stroke-linecap="round">
<animateTransform attributeName="transform" type="translate" values="0 0;-200 0" dur="4s" repeatCount="indefinite"/></path>
</svg>
'''


def footer(letters, t):
    text = '謝謝你來看小吉'
    width = letters.width(text, 22)
    heart_x = 600 + width / 2 + 16
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="130" viewBox="0 0 1200 130" aria-hidden="true">
<path fill="{t['accent']}" opacity=".35" d="M0 60 Q 150 20 300 60 T 600 60 T 900 60 T 1200 60 T 1500 60 T 1800 60 V130 H0 Z"><animateTransform attributeName="transform" type="translate" values="0 0;-600 0" dur="9s" repeatCount="indefinite"/></path>
<path fill="{t['accent2']}" opacity=".45" d="M0 75 Q 150 40 300 75 T 600 75 T 900 75 T 1200 75 T 1500 75 T 1800 75 V130 H0 Z"><animateTransform attributeName="transform" type="translate" values="-600 0;0 0" dur="7s" repeatCount="indefinite"/></path>
{letters.path(text, 600 - 12, 116, 22, t['ink'], 'middle', stroke=0.6)}
<path d="M{heart_x:.1f} 114 l-8 -8 a4.6 4.6 0 0 1 8 -5 a4.6 4.6 0 0 1 8 5 z" fill="{t['accent']}"><animate attributeName="opacity" values="1;.5;1" dur="1.4s" repeatCount="indefinite"/></path>
</svg>
'''


def chat(letters, t):
    loop = 14

    def fade(times, values):
        key_times = ';'.join(f'{time / loop:.4f}' for time in times)
        return f'<animate attributeName="opacity" values="{values}" keyTimes="{key_times}" dur="{loop}s" repeatCount="indefinite"/>'

    dots = ''.join(f'<circle cx="{x}" cy="179" r="3.5" fill="{t["accent"]}"><animate attributeName="opacity" values=".2;1;.2" dur="1.2s" begin="{delay}s" repeatCount="indefinite"/></circle>'
                   for x, delay in ((200, 0), (213, .2), (226, .4)))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="900" height="300" viewBox="0 0 900 300" role="img" aria-label="對話示範：問小吉天氣，小吉先回小吉思考中，再換成回答">
<defs><linearGradient id="av" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{t['accent']}"/><stop offset="1" stop-color="{t['accent2']}"/></linearGradient></defs>
<rect width="900" height="300" rx="18" fill="{t['chat_bg']}"/>
<rect width="900" height="46" rx="18" fill="{t['chat_panel']}"/><rect y="26" width="900" height="20" fill="{t['chat_panel']}"/>
{letters.path('# 小吉的聊天室', 24, 31, 20, t['chat_soft'], stroke=0.6)}
<line x1="0" y1="46" x2="900" y2="46" stroke="{t['chat_line']}"/>
<g opacity="0">{fade([0, .6, 1.0, 12.6, 13.2, 14], '0;0;1;1;0;0')}
<circle cx="44" cy="92" r="21" fill="{t['chat_soft']}" opacity=".35"/>{letters.path('你', 44, 100, 22, t['chat_ink'], 'middle', stroke=0.6)}
{letters.path('你', 78, 84, 20, t['chat_user'], stroke=0.7)}{letters.path('今天 晚上 8:30', 108, 84, 15, t['chat_soft'], stroke=0.3)}
{letters.path('小吉，今天台北天氣如何？', 78, 116, 24, t['chat_ink'], stroke=0.7)}
</g>
<g opacity="0">{fade([0, 1.6, 2.0, 12.6, 13.2, 14], '0;0;1;1;0;0')}
<circle cx="44" cy="164" r="21" fill="url(#av)"/>{letters.path('吉', 44, 173, 26, '#ffffff', 'middle', stroke=0.8)}
{letters.path('小吉', 78, 156, 20, t['accent'], stroke=0.7)}
<rect x="124" y="141" width="40" height="18" rx="4" fill="{t['accent']}"/>{letters.path('BOT', 144, 155, 13, '#ffffff', 'middle', stroke=0.4)}
</g>
<g opacity="0">{fade([0, 1.6, 2.0, 5.2, 5.5, 14], '0;0;1;1;0;0')}
{letters.path('小吉思考中', 78, 188, 24, t['chat_soft'], stroke=0.6)}{dots}
</g>
<g opacity="0">{fade([0, 5.3, 5.8, 12.6, 13.2, 14], '0;0;1;1;0;0')}
<rect x="74" y="166" width="620" height="92" rx="12" fill="{t['chat_bubble']}"/>
{letters.path('台北今天多雲時晴，最高 27°C、最低 21°C。', 92, 200, 23, t['chat_ink'], stroke=0.7)}
{letters.path('傍晚可能有短暫陣雨，出門記得帶把傘喔！', 92, 238, 23, t['chat_ink'], stroke=0.7)}
</g>
{letters.path('示範畫面', 876, 286, 15, t['chat_soft'], 'end', stroke=0.3)}
</svg>
'''


def icons(letters, t):
    a, b, m, bg = t['accent'], t['accent2'], t['mint'], t['icon_bg']

    def base(inner):
        return f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="18" fill="{bg}"/>{inner}</svg>\n'

    bounce = ''.join(f'<circle cx="{x}" cy="31" r="3.5" fill="#fff"><animate attributeName="cy" values="31;26;31" dur="1.2s" begin="{d}s" repeatCount="indefinite"/></circle>'
                     for x, d in ((22, 0), (32, .2), (42, .4)))
    rays = ''.join(f'<line x1="26" y1="12" x2="26" y2="16" stroke="{b}" stroke-width="3" stroke-linecap="round" transform="rotate({r} 26 28)"/>' for r in range(0, 360, 45))
    pips = ''.join(f'<circle cx="{x}" cy="{y}" r="3.2" fill="#fff"/>' for x, y in ((24, 24), (40, 24), (32, 32), (24, 40), (40, 40)))
    return {
        'chat': base(f'<path d="M14 16h36a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H28l-10 8v-8h-4a6 6 0 0 1-6-6V22a6 6 0 0 1 6-6z" fill="{a}"/>{bounce}'),
        'memory': base(f'<circle cx="32" cy="32" r="16" fill="none" stroke="{a}" stroke-width="4"/><circle cx="32" cy="32" r="16" fill="none" stroke="{b}" stroke-width="4" stroke-dasharray="20 81" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" values="0 32 32;360 32 32" dur="2.4s" repeatCount="indefinite"/></circle><path d="M26 32h12M32 26v12" stroke="{m}" stroke-width="4" stroke-linecap="round"><animate attributeName="opacity" values="1;.3;1" dur="1.6s" repeatCount="indefinite"/></path>'),
        'stock': base(f'<path d="M12 50h40" stroke="{m}" stroke-width="3" stroke-linecap="round"/><polyline points="12,44 22,34 30,40 40,24 52,18" fill="none" stroke="{a}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" stroke-dasharray="60" stroke-dashoffset="60"><animate attributeName="stroke-dashoffset" values="60;0;0" keyTimes="0;.6;1" dur="2.6s" repeatCount="indefinite"/></polyline><circle cx="52" cy="18" r="4" fill="{b}"><animate attributeName="r" values="0;0;4;4" keyTimes="0;.55;.65;1" dur="2.6s" repeatCount="indefinite"/></circle>'),
        'game': base(f'<g><animateTransform attributeName="transform" type="rotate" values="-12 32 32;12 32 32;-12 32 32" dur="2s" repeatCount="indefinite"/><rect x="16" y="16" width="32" height="32" rx="8" fill="{a}"/>{pips}</g>'),
        'coin': base(f'<g><animateTransform attributeName="transform" type="translate" values="0 0;0 -4;0 0" dur="1.6s" repeatCount="indefinite"/><ellipse cx="32" cy="32" rx="16" ry="16" fill="{b}"><animate attributeName="rx" values="16;3;16" dur="2.4s" repeatCount="indefinite"/></ellipse><g><animate attributeName="opacity" values="1;0;1" dur="2.4s" repeatCount="indefinite"/>{letters.path("吉", 32, 39, 20, "#ffffff", "middle", stroke=0.8)}</g></g>'),
        'weather': base(f'<g><animateTransform attributeName="transform" type="rotate" values="0 26 28;360 26 28" dur="10s" repeatCount="indefinite"/>{rays}</g><circle cx="26" cy="28" r="8" fill="{b}"/><g><animateTransform attributeName="transform" type="translate" values="0 0;4 0;0 0" dur="3s" repeatCount="indefinite"/><path d="M24 46a8 8 0 0 1 3-15 10 10 0 0 1 19 3 6 6 0 0 1 0 12z" fill="{a}"/></g>'),
        'topic': base(f'<rect x="14" y="14" width="36" height="36" rx="6" fill="{a}"/><g fill="#fff"><rect x="20" y="21" width="24" height="4" rx="2"/><rect x="20" y="30" width="18" height="3" rx="1.5"><animate attributeName="width" values="4;18;18" keyTimes="0;.5;1" dur="2s" repeatCount="indefinite"/></rect><rect x="20" y="37" width="22" height="3" rx="1.5"><animate attributeName="width" values="4;4;22" keyTimes="0;.5;1" dur="2s" repeatCount="indefinite"/></rect></g>'),
        'clock': base(f'<g><animateTransform attributeName="transform" type="rotate" values="0 32 34;-8 32 34;8 32 34;-8 32 34;0 32 34;0 32 34" keyTimes="0;.1;.2;.3;.4;1" dur="2.5s" repeatCount="indefinite"/><circle cx="32" cy="34" r="16" fill="{a}"/><circle cx="20" cy="16" r="5" fill="{b}"/><circle cx="44" cy="16" r="5" fill="{b}"/><line x1="32" y1="34" x2="32" y2="24" stroke="#fff" stroke-width="3" stroke-linecap="round"/><line x1="32" y1="34" x2="39" y2="38" stroke="#fff" stroke-width="3" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" values="0 32 34;360 32 34" dur="4s" repeatCount="indefinite"/></line></g>'),
    }


def title(letters, text, size):
    """A picture title: the text in the website's pink-to-peach gradient, readable on light and dark pages."""
    width = letters.width(text, size) + size * 0.4
    height = size * 1.45
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width:.0f}" height="{height:.0f}" viewBox="0 0 {width:.0f} {height:.0f}" role="img" aria-label="{text}">
<defs><linearGradient id="t" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="{width:.0f}" y2="0"><stop offset="0" stop-color="#e8789f"/><stop offset="1" stop-color="#f19a84"/></linearGradient></defs>
{letters.path(text, size * 0.1, size * 1.08, size, 'url(#t)', stroke=size / 40)}
</svg>
'''


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--source', required=True, help='ChenYuluoyan-2.0-Thin.ttf')
    args = parser.parse_args()
    digest = hashlib.sha256(pathlib.Path(args.source).read_bytes()).hexdigest()
    if digest != SOURCE_SHA256:
        raise SystemExit(f'{args.source} is not ChenYuluoyan 2.0 Thin (sha256 {digest}).')
    letters = Lettering(args.source)
    (OUT / 'icons').mkdir(parents=True, exist_ok=True)
    (OUT / 'titles').mkdir(parents=True, exist_ok=True)
    written = []

    def write(relative, text):
        (OUT / relative).write_text(text, encoding='utf-8')
        written.append(relative)

    for theme, colors in THEMES.items():
        write(f'banner-{theme}.svg', banner(letters, colors))
        write(f'divider-{theme}.svg', divider(colors))
        write(f'footer-{theme}.svg', footer(letters, colors))
        write(f'chat-{theme}.svg', chat(letters, colors))
        for name, svg in icons(letters, colors).items():
            write(f'icons/{name}-{theme}.svg', svg)
    for name, text in SECTION_TITLES:
        write(f'titles/{name}.svg', title(letters, text, 48))
    for name, text in FEATURE_TITLES:
        write(f'titles/{name}.svg', title(letters, text, 32))
    print(f'Wrote {len(written)} pictures to {OUT.relative_to(ROOT)}.')


if __name__ == '__main__':
    main()
