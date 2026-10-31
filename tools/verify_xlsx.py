"""结构校验 XLSX：确认图片以 OOXML drawing 形式真正内嵌在单元格中。
用法: python tools/verify_xlsx.py <file.xlsx> [期望图片数]
"""
import sys, zipfile, re
import xml.etree.ElementTree as ET

def main():
    if len(sys.argv) < 2:
        print("用法: python verify_xlsx.py <file.xlsx> [期望图片数]"); return 2
    f = sys.argv[1]
    expect = int(sys.argv[2]) if len(sys.argv) > 2 else None
    z = zipfile.ZipFile(f)
    names = z.namelist()
    bad = z.testzip()
    if bad:
        print("FAIL zip 损坏:", bad); return 1
    print("zip 完整性: OK, 部件数 =", len(names))

    # 1. 所有 XML 部件可解析
    xml_parts = [n for n in names if n.endswith(".xml") or n.endswith(".rels")]
    for n in xml_parts:
        try:
            ET.fromstring(z.read(n))
        except Exception as e:
            print("FAIL XML 解析失败", n, e); return 1
    print("XML 解析: OK (%d 个部件)" % len(xml_parts))

    # 2. 媒体文件
    media = [n for n in names if n.startswith("xl/media/") and not n.endswith("/")]
    print("内嵌媒体文件 (%d):" % len(media), media)
    nonempty = all(z.read(m) for m in media)
    if not media:
        print("FAIL 没有任何内嵌图片"); return 1
    if not nonempty:
        print("FAIL 存在空图片"); return 1
    if expect is not None and len(media) != expect:
        print("WARN 图片数 %d != 期望 %d" % (len(media), expect))

    # 3. Content_Types 声明
    ct = z.read("[Content_Types].xml").decode("utf-8")
    exts = set(re.findall(r'Default Extension="([^"]+)"', ct))
    if not ({"jpeg", "jpg", "png"} & {e.lower() for e in exts}):
        print("FAIL [Content_Types].xml 未声明图片扩展名:", exts); return 1
    print("Content_Types 图片扩展名: OK", sorted(e for e in exts if e.lower() in ("jpeg", "jpg", "png")))

    # 4. drawing 部件 + rels 指向 media
    drawings = [n for n in names if re.match(r"xl/drawings/drawing\d+\.xml$", n)]
    if not drawings:
        print("FAIL 缺少 xl/drawings/drawingN.xml"); return 1
    total_pics = 0
    for d in drawings:
        xml = z.read(d).decode("utf-8")
        pics = len(re.findall(r"<xdr:pic[ >]", xml))
        total_pics += pics
        rels = "xl/drawings/_rels/" + d.split("/")[-1] + ".rels"
        if rels not in names:
            print("FAIL 缺少 drawing rels:", rels); return 1
        rxml = z.read(rels).decode("utf-8")
        targets = re.findall(r'Target="([^"]+)"', rxml)
        if not any("media/" in t for t in targets):
            print("FAIL drawing rels 未指向 media:", targets); return 1
        print("  %s: <xdr:pic> x%d, rels -> %s" % (d, pics, targets))
    print("绘图图片元素总数:", total_pics)

    # 5. worksheet 引用 drawing
    sheets = [n for n in names if re.match(r"xl/worksheets/sheet\d+\.xml$", n)]
    linked = 0
    for s in sheets:
        xml = z.read(s).decode("utf-8")
        if "<drawing " in xml:
            rels = "xl/worksheets/_rels/" + s.split("/")[-1] + ".rels"
            if rels not in names:
                print("FAIL sheet 引用 drawing 但缺少 rels:", rels); return 1
            rxml = z.read(rels).decode("utf-8")
            if "drawings/drawing" not in rxml:
                print("FAIL sheet rels 未指向 drawing"); return 1
            linked += 1
            print("  %s -> drawing 关联 OK" % s)
    if not linked:
        print("FAIL 没有任何工作表关联 drawing（图片不会显示）"); return 1

    # 6. 表头解析（sharedStrings 或 inlineStr）
    shared = []
    if "xl/sharedStrings.xml" in names:
        ss = z.read("xl/sharedStrings.xml").decode("utf-8")
        shared = ["".join(t.text or "" for t in si.iter())
                  for si in ET.fromstring(ss).findall(
                      "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}si")]
    main_ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    anchor_ns = "{http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing}"

    sheet1 = "xl/worksheets/sheet1.xml"
    if sheet1 not in names:
        print("FAIL 缺少 sheet1.xml"); return 1
    root = ET.fromstring(z.read(sheet1))
    headers = {}
    for row in root.iter(main_ns + "row"):
        if row.get("r") != "1":
            continue
        for c in row.findall(main_ns + "c"):
            ref = c.get("r") or ""
            col = re.match(r"([A-Z]+)", ref)
            if not col:
                continue
            idx = 0
            for ch in col.group(1):
                idx = idx * 26 + (ord(ch) - 64)
            if c.get("t") == "s":
                v = c.find(main_ns + "v")
                txt = shared[int(v.text)] if v is not None and v.text else ""
            else:
                is_ = c.find(main_ns + "is")
                txt = "".join(t.text or "" for t in is_.iter()) if is_ is not None else ""
            headers[idx - 1] = txt

    if headers:
        img_cols = sorted(i for i, h in headers.items() if h.startswith("作品图片"))
        print("表头列数: %d，图片列索引(1基): %s" % (len(headers), [i + 1 for i in img_cols]))
        print("表头样例:", [headers[i] for i in sorted(headers)][:6], "...",
              [headers[i] for i in sorted(headers)[-6:]])
        for need in ("CN代称", "QQ号", "审核状态", "审核时间", "审核人", "推荐部门", "拒绝理由"):
            if not any(h == need for h in headers.values()):
                print("FAIL 导出缺少必需列:", need); return 1
        print("必需列齐全: CN代称 / QQ号 / 审核状态 / 审核时间 / 审核人 / 推荐部门 / 拒绝理由")

    # 7. 校验图片锚点确实落在「作品图片N」单元格内
    misplaced = 0
    placed = 0
    for d in drawings:
        droot = ET.fromstring(z.read(d))
        for anchor in list(droot):
            frm = anchor.find(anchor_ns + "from")
            if frm is None:
                continue
            acol = frm.find(anchor_ns + "col")
            arow = frm.find(anchor_ns + "row")
            if acol is None or arow is None:
                continue
            c0 = int(acol.text); r0 = int(arow.text)
            head = headers.get(c0, "")
            placed += 1
            if headers and not head.startswith("作品图片"):
                misplaced += 1
                print("  WARN 图片锚点列 %d 表头为「%s」，不在作品图片列" % (c0 + 1, head))
            else:
                print("  图片 #%d 落位：第 %d 行 × 第 %d 列「%s」" % (placed, r0 + 1, c0 + 1, head or "?"))
    if headers and misplaced:
        print("FAIL 有 %d 张图片未落在作品图片单元格" % misplaced); return 1

    print("\n✅ 通过：图片已作为 OOXML 绘图对象内嵌到对应「作品图片」单元格，可随文件直接预览")
    return 0

if __name__ == "__main__":
    sys.exit(main())
