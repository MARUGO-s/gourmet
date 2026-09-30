#!/usr/bin/env python3
"""PDF（AI分析レポート → M-talk）用の日本語フォントを作り直す。

Noto Sans JP（SIL Open Font License 1.1, supabase/functions/_shared/fonts/OFL-NotoSansJP.txt）の
可変フォントから Regular(400) / Bold(700) を固定し、CP932 の全文字（JIS 第1・第2水準、NEC特殊文字など）＋
ASCII・Latin-1・記号類に絞って、gzip + base64 の JS モジュールにする（Edge Function の --use-api
配置でも static_files なしで同梱できるように）。

  pip install fonttools
  curl -L -o /tmp/NotoSansJP-VF.ttf "https://github.com/google/fonts/raw/main/ofl/notosansjp/NotoSansJP%5Bwght%5D.ttf"
  python3 scripts/build-pdf-fonts.py /tmp/NotoSansJP-VF.ttf
"""
import base64, gzip, io, sys
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools import subset

src = sys.argv[1] if len(sys.argv) > 1 else "/tmp/NotoSansJP-VF.ttf"
out = "supabase/functions/_shared/fonts/noto-sans-jp.js"

chars = set()
for b1 in range(0x81, 0xFD):
    for b2 in range(0x40, 0xFD):
        try:
            chars.update(bytes([b1, b2]).decode("cp932"))
        except UnicodeDecodeError:
            pass
chars.update(chr(c) for c in range(0x20, 0x7F))
chars.update(chr(c) for c in range(0xA0, 0x100))
for a, b in [(0x2000, 0x206F), (0x2100, 0x218F), (0x2190, 0x21FF), (0x2200, 0x22FF), (0x2460, 0x24FF),
             (0x2500, 0x257F), (0x25A0, 0x25FF), (0x2600, 0x26FF), (0x3000, 0x30FF), (0xFF00, 0xFFEF)]:
    chars.update(chr(c) for c in range(a, b + 1))
text = "".join(sorted(chars))

def build(weight):
    font = instancer.instantiateVariableFont(TTFont(src), {"wght": weight}, updateFontNames=True)
    opts = subset.Options()
    opts.layout_features = []
    opts.hinting = False
    opts.desubroutinize = True
    opts.name_IDs = ["*"]
    opts.drop_tables += ["GSUB", "GPOS", "GDEF", "vhea", "vmtx", "VORG", "BASE"]
    sub = subset.Subsetter(opts)
    sub.populate(text=text)
    sub.subset(font)
    buf = io.BytesIO()
    font.save(buf)
    return base64.b64encode(gzip.compress(buf.getvalue(), 9, mtime=0)).decode("ascii")

regular, bold = build(400), build(700)
with open(out, "w") as f:
    f.write("// 生成ファイル（scripts/build-pdf-fonts.py）。編集しない。\n")
    f.write("// Noto Sans JP Regular/Bold の CP932 サブセット（gzip + base64）。SIL Open Font License 1.1（OFL-NotoSansJP.txt）。\n")
    f.write(f'export const NOTO_SANS_JP_REGULAR_GZ = "{regular}";\n')
    f.write(f'export const NOTO_SANS_JP_BOLD_GZ = "{bold}";\n')
print(out, len(regular) + len(bold), "chars")
