# -*- coding: utf-8 -*-
"""打包 YMS 免安装版：校验目录完整性 → 生成 YMS-App-免安装版.zip。

用法: python build/package.py
输出: D:\\AI Agent\\Hermes\\YMS\\YMS-App-免安装版.zip （内含 YMS-App/ 整个目录 + 使用说明.md）
"""
import io, os, re, sys, zipfile, hashlib

BASE = r"D:\AI Agent\Hermes\YMS"
APP = os.path.join(BASE, "YMS-App")
VER = "v1.0.0"
ROOT_NAME = "Mini-YMS-" + VER            # zip 内根目录名（解压出来就叫 Mini-YMS-v1.0.0）
OUTZIP = os.path.join(BASE, ROOT_NAME + ".zip")

REQUIRED = [
    "index.html", "使用说明.md",
    "css/theme.css", "css/layout.css", "css/components.css", "css/table.css", "css/plot.css", "css/report.css", "css/polish.css",
    "js/core/i18n.js", "js/core/i18n-dict-chrome.js", "js/core/i18n-dict-panels.js",
    "js/core/util.js", "js/core/events.js", "js/core/types.js", "js/core/dataframe.js", "js/core/store.js",
    "js/data/csv-parser.js", "js/data/importer.js", "js/data/exporter.js", "js/data/yms-template.js",
    "js/data/sample-data.embedded.js", "js/data/transform.js", "js/data/group-map.js",
    "js/table/data-grid.js", "js/table/column-ops.js", "js/table/table-view.js", "js/table/data-settings.js",
    "js/table/transform-ui.js", "js/table/expr-help.js", "js/table/group-ui.js",
    "js/plot/palettes.js", "js/plot/aggregate.js", "js/plot/axis.js", "js/plot/fitting.js", "js/plot/chart-builder.js",
    "js/plot/fullscreen.js", "js/plot/plot-view.js", "js/plot/plot-settings.js",
    "js/report/report.js", "js/report/pptx.js", "js/help.js", "js/app.js",
    "vendor/echarts.min.js", "vendor/xlsx.full.min.js",
]

def main():
    missing = [p for p in REQUIRED if not os.path.exists(os.path.join(APP, p.replace("/", os.sep)))]
    if missing:
        print("[FAIL] 缺少文件：")
        for m in missing:
            print("   -", m)
        sys.exit(1)

    # 示例数据随包分发（便于用真实文件演练 Data Import）
    sample_src = os.path.join(BASE, "sample_yield_data.csv")
    sample_dst_dir = os.path.join(APP, "sample")
    if os.path.exists(sample_src):
        os.makedirs(sample_dst_dir, exist_ok=True)
        dst = os.path.join(sample_dst_dir, "sample_yield_data.csv")
        with open(sample_src, "rb") as f:
            data = f.read()
        with open(dst, "wb") as f:
            f.write(data)
        print("[ok] 已随包附带示例数据 sample/sample_yield_data.csv")

    # 10 万行工艺数据集（迭代 5 新增，含 Layer/Tool/Chamber/StartTime/EndTime/MetroValue）
    big_src = os.path.join(BASE, "sample_yield_data_100k.csv")
    if os.path.exists(big_src):
        big_dst = os.path.join(sample_dst_dir, "sample_yield_data_100k.csv")
        with open(big_src, "rb") as f:
            big_data = f.read()
        with open(big_dst, "wb") as f:
            f.write(big_data)
        print("[ok] 已随包附带 10 万行数据集 sample/sample_yield_data_100k.csv (%.1f MB)"
              % (len(big_data) / 1048576.0))

    count = 0
    total = 0
    with zipfile.ZipFile(OUTZIP, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for root, dirs, files in os.walk(APP):
            # test/ 是开发期自动化用例（Playwright 脚本 + 夹具），不进交付包
            dirs[:] = [d for d in dirs if d not in ("__pycache__", ".git", "test")]
            for fn in files:
                full = os.path.join(root, fn)
                # 迭代 29：排除应用运行期留下的时间戳备份（如 sample_xxx-20261022-220630.csv，
                # 单个可达 10 MB）与常见临时文件 —— 它们只会把交付包撑大一倍
                if re.search(r"-\d{8}-\d{6}\.[A-Za-z0-9]+$", fn) \
                        or fn.endswith((".tmp", ".bak", ".log", ".orig", ".swp")) \
                        or fn.startswith("~$"):
                    print("     [skip] 排除运行期残留: %s" % os.path.relpath(full, BASE))
                    continue
                rel = os.path.relpath(full, APP).replace(os.sep, "/")
                z.write(full, ROOT_NAME + "/" + rel)          # 根目录统一为 Mini-YMS-v1.0.0/
                count += 1
                total += os.path.getsize(full)
    size = os.path.getsize(OUTZIP)
    print("[ok] 打包完成：%s" % OUTZIP)
    print("     文件数 %d，原始 %.2f MB，压缩后 %.2f MB（压缩率 %.1f%%）" % (
        count, total / 1048576.0, size / 1048576.0, 100.0 * size / max(total, 1)))

    # 校验压缩包完整性
    with zipfile.ZipFile(OUTZIP) as z:
        bad = z.testzip()
    print("[ok] 压缩包完整性校验：%s" % ("通过" if bad is None else ("损坏: " + str(bad))))
    with open(OUTZIP, "rb") as f:
        print("     sha256 = %s" % hashlib.sha256(f.read()).hexdigest())

if __name__ == "__main__":
    main()
