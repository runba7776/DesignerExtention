using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Web.Script.Serialization;
using System.Xml;

namespace DesignerExtension.Native
{
    // Check the saved chart cache (the values PowerPoint actually draws), not only
    // Excel cells. Embedded workbooks can be correct while Office caches are stale.
    internal static class ChartIntegrity
    {
        private const string C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
        private const string R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        private const string S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        // Only called for the new presentation just created by Renderer. Generate
        // its embedded data independently of live Excel's asynchronous OLE commit.
        // Verify remains read-only, including for user-provided presentations.
        public static void WriteGeneratedData(string pptx, string sceneFile)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 128 };
            var scene = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(sceneFile));
            object[] slides = Items(scene["slides"]);
            using (var file = new FileStream(pptx, FileMode.Open, FileAccess.ReadWrite, FileShare.Read))
            using (var zip = new ZipArchive(file, ZipArchiveMode.Update))
            for (int i = 0; i < slides.Length; i++)
            {
                var expected = new List<Dictionary<string, object>>();
                foreach (object element in Items(Map(slides[i])["elements"])) { var e = Map(element); if (Convert.ToString(e["kind"]) == "chart") expected.Add(e); }
                var slide = Read(zip,"ppt/slides/slide"+(i+1)+".xml");
                var actual = slide.GetElementsByTagName("chart",C);
                if (actual.Count != expected.Count) Fail(i,"グラフ数");
                if (expected.Count == 0) continue;
                var rels = Read(zip,"ppt/slides/_rels/slide"+(i+1)+".xml.rels");
                for (int j = 0; j < expected.Count; j++)
                {
                    string target = Related(rels,((XmlElement)actual[j]).GetAttribute("id",R));
                    var chartUri = new Uri(new Uri("https://package/ppt/slides/slide"+(i+1)+".xml"),target);
                    if (chartUri.Host != "package") Fail(i,"外部グラフ参照");
                    string chartPath = Uri.UnescapeDataString(chartUri.AbsolutePath.TrimStart('/'));
                    var chart = Read(zip,chartPath); var ns = new XmlNamespaceManager(chart.NameTable); ns.AddNamespace("c",C);
                    var data = chart.SelectSingleNode("//c:externalData",ns) as XmlElement;
                    if (data == null) Fail(i,"埋め込みデータ");
                    string relFile = chartPath.Substring(0,chartPath.LastIndexOf('/')+1)+"_rels/"+Path.GetFileName(chartPath)+".rels";
                    var bookUri = new Uri(new Uri("https://package/"+chartPath),Related(Read(zip,relFile),data.GetAttribute("id",R)));
                    if (bookUri.Host != "package") Fail(i,"埋め込みデータ参照");
                    var entry = zip.GetEntry(Uri.UnescapeDataString(bookUri.AbsolutePath.TrimStart('/')));
                    if (entry == null) Fail(i,"Excelデータ");
                    byte[] bytes = GeneratedWorkbook(expected[j]);
                    using (var stream = entry.Open()) { stream.SetLength(0); stream.Write(bytes,0,bytes.Length); }
                }
            }
        }
        private static byte[] GeneratedWorkbook(Dictionary<string, object> data)
        {
            object[] categories = Items(data["categories"]), series = Items(data["series"]);
            using (var memory = new MemoryStream())
            {
                using (var zip = new ZipArchive(memory,ZipArchiveMode.Create,true))
                {
                    WritePart(zip,"[Content_Types].xml","<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/><Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/></Types>");
                    WritePart(zip,"_rels/.rels","<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\""+R+"/officeDocument\" Target=\"xl/workbook.xml\"/></Relationships>");
                    WritePart(zip,"xl/workbook.xml","<workbook xmlns=\""+S+"\" xmlns:r=\""+R+"\"><sheets><sheet name=\"Data\" sheetId=\"1\" r:id=\"rId1\"/></sheets></workbook>");
                    WritePart(zip,"xl/_rels/workbook.xml.rels","<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\""+R+"/worksheet\" Target=\"worksheets/sheet1.xml\"/></Relationships>");
                    var doc = new XmlDocument(); var worksheet = doc.CreateElement("worksheet",S); doc.AppendChild(worksheet);
                    var dimension = doc.CreateElement("dimension",S); dimension.SetAttribute("ref","A1:"+((char)('A'+series.Length))+""+(categories.Length+1)); worksheet.AppendChild(dimension);
                    var rows = doc.CreateElement("sheetData",S); worksheet.AppendChild(rows);
                    for (int r = 0; r <= categories.Length; r++)
                    {
                        var row = doc.CreateElement("row",S); row.SetAttribute("r",(r+1).ToString(CultureInfo.InvariantCulture)); rows.AppendChild(row);
                        for (int c = 0; c <= series.Length; c++)
                        {
                            var cell = doc.CreateElement("c",S); cell.SetAttribute("r",((char)('A'+c))+""+(r+1)); row.AppendChild(cell);
                            if (r == 0 || c == 0)
                            {
                                // Inline strings keep labels beginning with '=' as text.
                                cell.SetAttribute("t","inlineStr"); var inline = doc.CreateElement("is",S); var text = doc.CreateElement("t",S); var space = doc.CreateAttribute("xml","space","http://www.w3.org/XML/1998/namespace"); space.Value = "preserve"; text.Attributes.Append(space);
                                text.InnerText = r == 0 ? c == 0 ? "項目" : Convert.ToString(Map(series[c-1])["name"]) : Convert.ToString(categories[r-1]); inline.AppendChild(text); cell.AppendChild(inline);
                            }
                            else
                            {
                                double number = Convert.ToDouble(Items(Map(series[c-1])["values"])[r-1],CultureInfo.InvariantCulture);
                                if (Double.IsNaN(number) || Double.IsInfinity(number)) throw new InvalidDataException("グラフの数値が無効です。");
                                var value = doc.CreateElement("v",S); value.InnerText = number.ToString("R",CultureInfo.InvariantCulture); cell.AppendChild(value);
                            }
                        }
                    }
                    using (var stream = zip.CreateEntry("xl/worksheets/sheet1.xml").Open()) doc.Save(stream);
                }
                return memory.ToArray();
            }
        }
        private static void WritePart(ZipArchive zip, string name, string xml) { using (var writer = new StreamWriter(zip.CreateEntry(name).Open(),new System.Text.UTF8Encoding(false))) writer.Write(xml); }
        public static void Verify(string pptx, string sceneFile) { Check(pptx, sceneFile, false); }
        public static void Synchronize(string pptx, string sceneFile) { Check(pptx, sceneFile, true); }
        private static void Check(string pptx, string sceneFile, bool synchronize)
        {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 128 };
            var scene = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(sceneFile));
            object[] slides = Items(scene["slides"]);
            using (var file = new FileStream(pptx, FileMode.Open, synchronize ? FileAccess.ReadWrite : FileAccess.Read, FileShare.Read))
            using (var zip = new ZipArchive(file, synchronize ? ZipArchiveMode.Update : ZipArchiveMode.Read))
            for (int i = 0; i < slides.Length; i++)
            {
                var expected = new List<Dictionary<string, object>>();
                foreach (object item in Items(Map(slides[i])["elements"]))
                {
                    var e = Map(item);
                    if (Convert.ToString(e["kind"]) == "chart") expected.Add(e);
                }
                var slide = Read(zip, "ppt/slides/slide" + (i + 1) + ".xml");
                var actual = slide.GetElementsByTagName("chart", C);
                if (actual.Count != expected.Count) Fail(i, "グラフ数");
                if (expected.Count == 0) continue;
                var rels = Read(zip, "ppt/slides/_rels/slide" + (i + 1) + ".xml.rels");
                for (int j = 0; j < expected.Count; j++)
                {
                    string id = ((XmlElement)actual[j]).GetAttribute("id", R), target = null;
                    foreach (XmlElement rel in rels.DocumentElement.ChildNodes)
                        if (rel.GetAttribute("Id") == id && rel.GetAttribute("TargetMode") != "External") target = rel.GetAttribute("Target");
                    if (target == null) Fail(i, "グラフ参照");
                    var uri = new Uri(new Uri("https://package/ppt/slides/slide" + (i + 1) + ".xml"), target);
                    if (uri.Host != "package") Fail(i, "外部グラフ参照");
                    string chartPath = Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/'));
                    var chart = Read(zip, chartPath);
                    var ns = new XmlNamespaceManager(chart.NameTable); ns.AddNamespace("c", C);
                    string type = Convert.ToString(expected[j]["chartType"]);
                    string node = type == "pie" ? "pieChart" : type == "doughnut" ? "doughnutChart" : type == "line" ? "lineChart" : "barChart";
                    var typeNode = chart.SelectSingleNode("//c:plotArea/c:"+node, ns);
                    if (typeNode == null) Fail(i,"グラフ形式");
                    if (node == "barChart") {
                        string direction = type == "bar" || type == "stackedBar" ? "bar" : "col", grouping = type == "stackedBar" || type == "stackedColumn" ? "stacked" : "clustered";
                        var dir = typeNode.SelectSingleNode("c:barDir", ns) as XmlElement; var group = typeNode.SelectSingleNode("c:grouping", ns) as XmlElement;
                        if (dir == null || dir.GetAttribute("val") != direction || group == null || group.GetAttribute("val") != grouping) Fail(i,"グラフの方向・積み上げ形式");
                    }
                    var series = chart.SelectNodes("//c:ser", ns);
                    object[] wanted = Items(expected[j]["series"]), categories = Items(expected[j]["categories"]);
                    string sheetName = VerifyWorkbook(zip, chartPath, chart, ns, expected[j], i);
                    if (synchronize && series.Count > 0)
                    {
                        // A stale cache can retain Excel's three default series as well.
                        // The verified workbook, not those cached nodes, is authoritative.
                        var plot = series[0].ParentNode;
                        while (series.Count > wanted.Length) { plot.RemoveChild(series[series.Count-1]); series = chart.SelectNodes("//c:ser", ns); }
                        while (series.Count < wanted.Length) { plot.InsertAfter(series[0].CloneNode(true),series[series.Count-1]); series = chart.SelectNodes("//c:ser", ns); }
                    }
                    if (series.Count != wanted.Length) Fail(i, "系列数");
                    for (int k = 0; k < wanted.Length; k++)
                    {
                        var item = Map(wanted[k]);
                        if (synchronize)
                        {
                            string prefix = "'" + sheetName.Replace("'", "''") + "'!", column = ((char)('B'+k)).ToString();
                            ((XmlElement)series[k].SelectSingleNode("c:idx",ns)).SetAttribute("val",k.ToString(CultureInfo.InvariantCulture));
                            ((XmlElement)series[k].SelectSingleNode("c:order",ns)).SetAttribute("val",k.ToString(CultureInfo.InvariantCulture));
                            Formula(series[k],"c:tx/c:strRef/c:f",prefix+"$"+column+"$1",ns);
                            Formula(series[k],"c:cat/c:strRef/c:f",prefix+"$A$2:$A$"+(categories.Length+1),ns);
                            Formula(series[k],"c:val/c:numRef/c:f",prefix+"$"+column+"$2:$"+column+"$"+(categories.Length+1),ns);
                            Cache(series[k], "c:tx/c:strRef", "strCache", new object[] { item["name"] }, ns);
                            Cache(series[k], "c:cat/c:strRef", "strCache", categories, ns);
                            Cache(series[k], "c:val/c:numRef", "numCache", Items(item["values"]), ns);
                        }
                        var name = series[k].SelectSingleNode("c:tx//c:v", ns);
                        if (name == null || name.InnerText != Convert.ToString(item["name"])) Fail(i, "系列名");
                        var labels = Points(series[k], "c:cat//c:pt", ns);
                        var values = Points(series[k], "c:val//c:pt", ns);
                        object[] numbers = Items(item["values"]);
                        if (labels.Count != categories.Length || values.Count != numbers.Length) Fail(i, "項目数");
                        for (int p = 0; p < categories.Length; p++)
                        {
                            string label, value; double parsed;
                            if (!labels.TryGetValue(p, out label) || label != Convert.ToString(categories[p])) Fail(i, "項目名");
                            double number = Convert.ToDouble(numbers[p], CultureInfo.InvariantCulture);
                            if (!values.TryGetValue(p, out value) || !Double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out parsed)
                                || Double.IsNaN(parsed) || Double.IsInfinity(parsed) || Math.Abs(parsed - number) > Math.Max(1, Math.Abs(number)) * 1e-10) Fail(i, "表示値");
                        }
                    }
                    if (synchronize)
                    {
                        // Embedded Excel may restore its automatic title on close.
                        // The slide title and source caption already name the chart.
                        var title = chart.SelectSingleNode("/c:chartSpace/c:chart/c:title",ns); if (title != null) title.ParentNode.RemoveChild(title);
                        var deleted = chart.SelectSingleNode("/c:chartSpace/c:chart/c:autoTitleDeleted",ns) as XmlElement;
                        if (deleted == null) { deleted = chart.CreateElement("c","autoTitleDeleted",C); var plotArea = chart.SelectSingleNode("/c:chartSpace/c:chart/c:plotArea",ns); plotArea.ParentNode.InsertBefore(deleted,plotArea); } deleted.SetAttribute("val","1");
                        // Keep horizontal categories in input order without asking live
                        // embedded Excel to reflow its workbook while we are committing it.
                        if ((type == "bar" || type == "stackedBar") && expected[j].ContainsKey("categoryOrder")) {
                            var catAxis = chart.SelectSingleNode("//c:catAx",ns);
                            if (catAxis == null) Fail(i,"項目軸");
                            var scaling = catAxis.SelectSingleNode("c:scaling",ns);
                            var orientation = scaling.SelectSingleNode("c:orientation",ns) as XmlElement;
                            if (orientation == null) { orientation = chart.CreateElement("c","orientation",C); scaling.PrependChild(orientation); } orientation.SetAttribute("val","maxMin");
                            // The category axis crosses the value axis at zero. Moving
                            // this crossing to max would draw bars from the wrong end.
                            var crosses = catAxis.SelectSingleNode("c:crosses",ns) as XmlElement;
                            if (crosses != null) crosses.SetAttribute("val","autoZero");
                            var valueAxis = chart.SelectSingleNode("//c:valAx",ns);
                            var valueCrosses = valueAxis == null ? null : valueAxis.SelectSingleNode("c:crosses",ns) as XmlElement;
                            if (valueCrosses != null) valueCrosses.SetAttribute("val","max");
                        }
                        using (var stream = zip.GetEntry(chartPath).Open())
                        { stream.SetLength(0); chart.Save(stream); }
                    }
                    if ((type == "bar" || type == "stackedBar") && expected[j].ContainsKey("categoryOrder"))
                    {
                        var orientation = chart.SelectSingleNode("//c:catAx/c:scaling/c:orientation",ns) as XmlElement;
                        var origin = chart.SelectSingleNode("//c:catAx/c:crosses",ns) as XmlElement;
                        var crossing = chart.SelectSingleNode("//c:valAx/c:crosses",ns) as XmlElement;
                        if (orientation == null || orientation.GetAttribute("val") != "maxMin" || origin == null || origin.GetAttribute("val") != "autoZero" || crossing == null || crossing.GetAttribute("val") != "max") Fail(i,"項目順・ゼロ基準");
                    }
                }
            }
        }
        private static void Formula(XmlNode series, string selector, string formula, XmlNamespaceManager ns)
        {
            var node = series.SelectSingleNode(selector, ns);
            if (node == null) throw new InvalidDataException("CHART_DATA_MISMATCH: 編集可能なセル参照がありません。");
            node.InnerText = formula;
        }
        private static void Cache(XmlNode series, string selector, string cacheName, object[] values, XmlNamespaceManager ns)
        {
            var reference = series.SelectSingleNode(selector, ns);
            if (reference == null || reference.SelectSingleNode("c:f", ns) == null)
                throw new InvalidDataException("CHART_DATA_MISMATCH: 編集可能なグラフのセル参照がありません。");
            var doc = series.OwnerDocument;
            var old = reference.SelectSingleNode("c:" + cacheName, ns);
            if (old != null) reference.RemoveChild(old);
            var cache = doc.CreateElement("c", cacheName, C);
            if (cacheName == "numCache") { var format = doc.CreateElement("c", "formatCode", C); format.InnerText = "General"; cache.AppendChild(format); }
            var count = doc.CreateElement("c", "ptCount", C); count.SetAttribute("val", values.Length.ToString(CultureInfo.InvariantCulture)); cache.AppendChild(count);
            for (int i = 0; i < values.Length; i++)
            {
                var point = doc.CreateElement("c", "pt", C); point.SetAttribute("idx", i.ToString(CultureInfo.InvariantCulture));
                var value = doc.CreateElement("c", "v", C); value.InnerText = Convert.ToString(values[i], CultureInfo.InvariantCulture);
                point.AppendChild(value); cache.AppendChild(point);
            }
            reference.AppendChild(cache);
        }
        private static string VerifyWorkbook(ZipArchive zip, string chartPath, XmlDocument chart, XmlNamespaceManager ns, Dictionary<string, object> expected, int slide)
        {
            var data = chart.SelectSingleNode("//c:externalData", ns) as XmlElement;
            if (data == null) Fail(slide, "埋め込みデータ");
            string relFile = chartPath.Substring(0, chartPath.LastIndexOf('/') + 1) + "_rels/" + Path.GetFileName(chartPath) + ".rels";
            string target = Related(Read(zip, relFile), data.GetAttribute("id", R));
            var uri = new Uri(new Uri("https://package/" + chartPath), target);
            if (uri.Host != "package") Fail(slide, "埋め込みデータ参照");
            var entry = zip.GetEntry(Uri.UnescapeDataString(uri.AbsolutePath.TrimStart('/')));
            if (entry == null) Fail(slide, "Excelデータ");
            using (var memory = new MemoryStream())
            {
                using (var stream = entry.Open()) stream.CopyTo(memory);
                memory.Position = 0;
                using (var workbook = new ZipArchive(memory, ZipArchiveMode.Read))
                {
                    const string S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
                    var book = Read(workbook, "xl/workbook.xml");
                    var first = (XmlElement)book.GetElementsByTagName("sheet", S)[0];
                    string sheetTarget = Related(Read(workbook, "xl/_rels/workbook.xml.rels"), first.GetAttribute("id", R));
                    string sheetPath = new Uri(new Uri("https://package/xl/workbook.xml"), sheetTarget).AbsolutePath.TrimStart('/');
                    var sheet = Read(workbook, sheetPath);
                    var sx = new XmlNamespaceManager(sheet.NameTable); sx.AddNamespace("s", S);
                    var strings = new List<string>();
                    if (workbook.GetEntry("xl/sharedStrings.xml") != null)
                    {
                        var shared = Read(workbook, "xl/sharedStrings.xml");
                        foreach (XmlElement item in shared.GetElementsByTagName("si", S))
                        { string value = ""; foreach (XmlElement t in item.GetElementsByTagName("t", S)) value += t.InnerText; strings.Add(value); }
                    }
                    var cells = new Dictionary<string, string>();
                    foreach (XmlElement cell in sheet.GetElementsByTagName("c", S))
                    {
                        var valueNode = cell.SelectSingleNode("s:v", sx);
                        string value = valueNode == null ? "" : valueNode.InnerText;
                        if (cell.GetAttribute("t") == "s") value = strings[Int32.Parse(value, CultureInfo.InvariantCulture)];
                        if (cell.GetAttribute("t") == "inlineStr") { value = ""; foreach (XmlElement t in cell.GetElementsByTagName("t", S)) value += t.InnerText; }
                        cells[cell.GetAttribute("r")] = value;
                    }
                    object[] categories = Items(expected["categories"]), series = Items(expected["series"]);
                    for (int r = 0; r < categories.Length; r++) CheckCell(cells, "A" + (r + 2), categories[r], false, slide);
                    for (int col = 0; col < series.Length; col++)
                    {
                        string column = ((char)('B' + col)).ToString(); var item = Map(series[col]);
                        CheckCell(cells, column + "1", item["name"], false, slide);
                        var numbers = Items(item["values"]);
                        for (int r = 0; r < numbers.Length; r++) CheckCell(cells, column + (r + 2), numbers[r], true, slide);
                    }
                    return first.GetAttribute("name");
                }
            }
        }
        private static string Related(XmlDocument relationships, string id)
        {
            foreach (XmlElement rel in relationships.DocumentElement.ChildNodes)
                if (rel.GetAttribute("Id") == id && rel.GetAttribute("TargetMode") != "External") return rel.GetAttribute("Target");
            throw new InvalidDataException("CHART_DATA_MISMATCH: 内部データ参照がありません。");
        }
        private static void CheckCell(Dictionary<string, string> cells, string address, object expected, bool numeric, int slide)
        {
            string actual;
            if (!cells.TryGetValue(address, out actual)) Fail(slide, "Excelセル " + address);
            if (!numeric) { if (actual != Convert.ToString(expected, CultureInfo.InvariantCulture)) Fail(slide, "Excelセル " + address); return; }
            double value, wanted = Convert.ToDouble(expected, CultureInfo.InvariantCulture);
            if (!Double.TryParse(actual, NumberStyles.Float, CultureInfo.InvariantCulture, out value) || Double.IsNaN(value) || Double.IsInfinity(value) || Math.Abs(value-wanted)>Math.Max(1,Math.Abs(wanted))*1e-10) Fail(slide, "Excelセル " + address);
        }
        private static Dictionary<int, string> Points(XmlNode node, string selector, XmlNamespaceManager ns)
        {
            var result = new Dictionary<int, string>();
            foreach (XmlElement point in node.SelectNodes(selector, ns))
                result.Add(Int32.Parse(point.GetAttribute("idx"), CultureInfo.InvariantCulture), point.SelectSingleNode("c:v", ns).InnerText);
            return result;
        }
        private static XmlDocument Read(ZipArchive zip, string name)
        {
            var entry = zip.GetEntry(name);
            if (entry == null) throw new InvalidDataException("CHART_DATA_MISMATCH: グラフ部品がありません。");
            var doc = new XmlDocument { XmlResolver = null };
            using (var stream = entry.Open())
            using (var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null })) doc.Load(reader);
            return doc;
        }
        private static Dictionary<string, object> Map(object item) { return (Dictionary<string, object>)item; }
        private static object[] Items(object item) { var a = item as object[]; return a ?? ((ArrayList)item).ToArray(); }
        private static void Fail(int slide, string detail) { throw new InvalidDataException("CHART_DATA_MISMATCH: スライド " + (slide + 1) + " のグラフの" + detail + "が入力と一致しません。出力を中止しました。"); }
    }
}
