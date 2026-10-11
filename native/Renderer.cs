using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace DesignerExtension.Native
{
    // This executable accepts data only. It never evaluates generated code or macros.
    internal static class Renderer
    {
        private static readonly List<string> Warnings = new List<string>();
        private static string FontName = "Yu Gothic";
        private static readonly HashSet<string> InstalledFonts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private static readonly Dictionary<string,string> ResolvedFonts = new Dictionary<string,string>(StringComparer.OrdinalIgnoreCase);
        private static int Foreground = Color("#17263C");
        private static int Accent = Color("#087F8C");
        private static string Stage = "初期化";

        [STAThread]
        private static int Main(string[] args)
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            if (args.Length == 1 && args[0] == "--load-addin") return LoadAddIn();
            if (args.Length == 2 && args[0] == "--open") return OpenPresentation(args[1]);
            if (args.Length == 3 && args[0] == "--verify-charts")
            {
                try { ChartIntegrity.Verify(args[2], args[1]); Console.WriteLine("Chart values verified."); return 0; }
                catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
            }
            string input = null, output = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--input" && i + 1 < args.Length) input = args[++i];
                else if (args[i] == "--output" && i + 1 < args.Length) output = args[++i];
                else { Console.Error.WriteLine("Usage: DesignerExtension.Renderer.exe --input scene.json --output directory"); return 2; }
            }
            if (input == null || output == null) return 2;
            dynamic app = null, presentation = null;
            bool startedPowerPoint = false;
            try
            {
                input = Path.GetFullPath(input);
                output = Path.GetFullPath(output);
                var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024, RecursionLimit = 128 };
                var scene = serializer.Deserialize<Dictionary<string, object>>(File.ReadAllText(input, Encoding.UTF8));
                var slides = ArrayOf(scene, "slides");
                if (slides.Length < 1 || slides.Length > 30) throw new InvalidDataException("スライドは表紙を含め1〜30枚にしてください。");
                Directory.CreateDirectory(output);
                var theme = ObjectOf(scene, "theme");
                using (var fonts = new System.Drawing.Text.InstalledFontCollection())
                    foreach (var family in fonts.Families)
                    {
                        InstalledFonts.Add(family.Name);
                        InstalledFonts.Add(family.GetName(1033));
                        InstalledFonts.Add(family.GetName(1041));
                        family.Dispose();
                    }
                FontName = ResolveFont(Text(theme, "font", "Yu Gothic"), "Yu Gothic");
                Foreground = Color(Text(theme, "foreground", "#17263C"));
                Accent = Color(Text(theme, "accent", "#087F8C"));
                OleMessageFilter.Register();
                Stage = "PowerPointへの接続";
                var type = Type.GetTypeFromProgID("PowerPoint.Application", true);
                startedPowerPoint = System.Diagnostics.Process.GetProcessesByName("POWERPNT").Length == 0;
                app = Activator.CreateInstance(type);
                // PowerPoint may reuse an existing process. Do not change global options,
                // touch user presentations, or call Application.Quit in cleanup.
                Stage = "新規プレゼンテーションの作成";
                presentation = app.Presentations.Add(-1);
                Stage = "ページとテーマの設定";
                presentation.PageSetup.SlideWidth = 960;
                presentation.PageSetup.SlideHeight = 540;
                try
                {
                    dynamic scheme = presentation.SlideMaster.Theme.ThemeColorScheme;
                    scheme.Colors(5).RGB = Accent;
                    scheme.Colors(1).RGB = Foreground;
                }
                catch { Warnings.Add("テーマの一部は図形ごとの書式で適用しました。"); }
                var thumbs = new List<string>();
                for (int i = 0; i < slides.Length; i++)
                {
                    var data = AsObject(slides[i]);
                    Stage = "スライド " + (i + 1) + " の作成";
                    dynamic slide = presentation.Slides.Add(i + 1, 12);
                    slide.FollowMasterBackground = 0;
                    slide.Background.Fill.Solid();
                    slide.Background.Fill.ForeColor.RGB = Color(Text(theme, "background", "#FFFFFF"));
                    try { slide.Name = "DE_" + (i + 1).ToString(CultureInfo.InvariantCulture); } catch { }
                    foreach (object element in ArrayOf(data, "elements"))
                    {
                        var e = AsObject(element);
                        string kind = Text(e, "kind", "");
                        Stage = "スライド " + (i + 1) + " の " + kind + " の配置";
                        ValidateBounds(e, i + 1);
                        if (kind == "text") AddText(slide, e, i + 1);
                        else if (kind == "shape") AddShape(slide, e);
                        else if (kind == "line") AddLine(slide, e);
                        else if (kind == "chart") AddChart(slide, e, i + 1);
                        else if (kind == "smartart") AddSmartArt(app, slide, e, i + 1);
                        else if (kind == "image") AddImage(slide, e, output, i + 1);
                        else throw new InvalidDataException("Unknown element kind: " + kind);
                    }
                    Stage = "スライド " + (i + 1) + " のノート保存";
                    WriteNotes(slide, Text(data, "notes", ""));
                    foreach (object warning in ArrayOf(data, "warnings")) Warnings.Add("スライド " + (i + 1) + ": " + Convert.ToString(warning));
                    Release((object)slide);
                }
                string pptx = Path.Combine(output, "presentation.pptx");
                if (File.Exists(pptx)) throw new IOException("既存の出力ファイルは上書きできません。新しい出力先を選んでください。");
                Stage = "PPTXの保存";
                presentation.SaveAs(pptx, 24, 0);
                // Excel can commit its cells without refreshing PowerPoint's chart cache.
                // Close only our new deck, verify its embedded cells, synchronize caches,
                // and reopen it so previews use exactly the delivered PPTX.
                presentation.Close(); Release((object)presentation); presentation = null;
                Stage = "編集可能なグラフデータの組み立て";
                ChartIntegrity.WriteGeneratedData(pptx, input);
                Stage = "グラフ表示キャッシュの同期";
                ChartIntegrity.Synchronize(pptx, input);
                Stage = "保存したグラフの数値照合";
                ChartIntegrity.Verify(pptx, input);
                presentation = app.Presentations.Open(pptx, -1, 0, -1);
                for (int i = 1; i <= slides.Length; i++)
                {
                    dynamic slide = presentation.Slides.Item(i);
                    Stage = "スライド " + i + " のプレビュー出力";
                    string thumb = "slide-" + i.ToString(CultureInfo.InvariantCulture) + ".png";
                    slide.Export(Path.Combine(output, thumb), "PNG", 1600, 900);
                    thumbs.Add(thumb);
                    Release((object)slide);
                }
                File.WriteAllText(Path.Combine(output, "render-result.json"), serializer.Serialize(new {
                    pptx = "presentation.pptx", thumbnails = thumbs, warnings = Warnings, native = true
                }), new UTF8Encoding(false));
                Console.WriteLine("PowerPoint presentation and previews created.");
                return 0;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("PowerPoint生成に失敗しました（" + Stage + "）: " + ex.Message);
                Console.Error.WriteLine(ex.StackTrace);
                return 1;
            }
            finally
            {
                if ((object)presentation != null) { try { presentation.Saved = -1; presentation.Close(); } catch { } Release((object)presentation); }
                // Quit only a PowerPoint this renderer launched and only when nothing
                // else was opened in it, so no idle PowerPoint is left behind.
                if (startedPowerPoint && (object)app != null) { try { if ((int)app.Presentations.Count == 0) app.Quit(); } catch { } }
                Release((object)app);
                OleMessageFilter.Revoke();
                GC.Collect(); GC.WaitForPendingFinalizers();
            }
        }

        private static int OpenPresentation(string filename)
        {
            dynamic app = null, presentation = null;
            try
            {
                string path = Path.GetFullPath(filename);
                if (!File.Exists(path) || !String.Equals(Path.GetExtension(path), ".pptx", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("開くファイルは存在するPPTXにしてください。");
                OleMessageFilter.Register();
                app = Activator.CreateInstance(Type.GetTypeFromProgID("PowerPoint.Application", true));
                app.Visible = -1;
                presentation = app.Presentations.Open(path, 0, 0, -1);
                Console.WriteLine("Presentation opened in PowerPoint.");
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine("PowerPointで開けませんでした: " + ex.Message); return 1; }
            finally { Release((object)presentation); Release((object)app); OleMessageFilter.Revoke(); }
        }

        private static int LoadAddIn()
        {
            object appObject = null, addinsObject = null, addinObject = null;
            try
            {
                OleMessageFilter.Register();
                // Load only this registered add-in into an already running PowerPoint.
                // Automation-launched Office instances can omit startup add-ins.
                appObject = Marshal.GetActiveObject("PowerPoint.Application");
                dynamic app = appObject;
                addinsObject = app.COMAddIns;
                dynamic addins = addinsObject;
                addins.Update();
                Console.WriteLine("Registered PowerPoint COM add-ins: " + addins.Count);
                for(int i = 1; i <= (int)addins.Count; i++) {
                    dynamic known = addins.Item(i);
                    Console.WriteLine("COM add-in: " + known.ProgId);
                    Release((object)known);
                }
                addinObject = addins.Item("DesignerExtension.Connect");
                dynamic addin = addinObject;
                addin.Connect = true;
                if (!(bool)addin.Connect) throw new InvalidOperationException("PowerPointがアドインを読み込みませんでした。");
                Console.WriteLine("Designer Extention add-in is connected.");
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine("アドイン確認: " + ex.Message); return 1; }
            finally { Release(addinObject); Release(addinsObject); Release(appObject); OleMessageFilter.Revoke(); }
        }

        private static void ValidateBounds(Dictionary<string, object> e, int slide)
        {
            float x = Number(e, "x"), y = Number(e, "y"), w = Number(e, "w"), h = Number(e, "h");
            if (float.IsNaN(x) || float.IsNaN(y) || float.IsNaN(w) || float.IsNaN(h) ||
                float.IsInfinity(x) || float.IsInfinity(y) || float.IsInfinity(w) || float.IsInfinity(h))
                throw new InvalidDataException("図形の座標が無効です。");
            if (w < 0 || h < 0 || w > 1920 || h > 1080 || Math.Abs(x) > 1920 || Math.Abs(y) > 1080)
                throw new InvalidDataException("図形の大きさ・座標が許容範囲外です。");
            if (x < -0.1 || y < -0.1 || x + w > 960.1 || y + h > 540.1)
                Warnings.Add("スライド " + slide + ": スライド外に配置される要素があります。");
        }

        private static dynamic AddText(dynamic slide, Dictionary<string, object> e, int slideNumber)
        {
            dynamic shape = slide.Shapes.AddTextbox(1, Number(e, "x"), Number(e, "y"), Number(e, "w"), Number(e, "h"));
            dynamic frame = shape.TextFrame2;
            frame.AutoSize = 0;
            frame.WordWrap = Boolean(e,"noWrap") ? 0 : -1;
            frame.MarginLeft = Number(e, "padding", 0);
            frame.MarginRight = Number(e, "padding", 0);
            frame.MarginTop = Number(e, "padding", 0);
            frame.MarginBottom = Number(e, "padding", 0);
            string vertical = Text(e, "verticalAlign", "top");
            frame.VerticalAnchor = vertical == "middle" ? 3 : vertical == "bottom" ? 4 : 1;
            dynamic range = frame.TextRange;
            range.Text = Text(e, "text", "");
            range.Font.Name = ResolveFont(Text(e, "font", FontName), FontName);
            range.Font.NameFarEast = ResolveFont(Text(e, "fontFarEast", Text(e, "font", FontName)), FontName);
            range.Font.Size = Number(e, "fontSize", 22);
            range.Font.Bold = Boolean(e, "bold") ? -1 : 0;
            range.Font.Italic = Boolean(e, "italic") ? -1 : 0;
            range.Font.Fill.ForeColor.RGB = Color(Text(e, "color", null), Foreground);
            string align = Text(e, "align", "left");
            range.ParagraphFormat.Alignment = align == "center" ? 2 : align == "right" ? 3 : 1;
            range.ParagraphFormat.SpaceAfter = Number(e, "paragraphSpacing", 0);
            // Fixed line pitch (points between baselines) for text laid out by a browser.
            if (e.ContainsKey("lineHeight")) { range.ParagraphFormat.LineRuleWithin = 0; range.ParagraphFormat.SpaceWithin = Number(e, "lineHeight", 0); }
            // Browser-measured text keeps its lines; only report if PowerPoint sets it wider.
            if (Boolean(e, "exact")) { if ((float)range.BoundWidth > Number(e, "w") * 1.08f) Warnings.Add("スライド " + slideNumber + ": 文字がわずかに枠より広く表示されます（" + Short(Convert.ToString(range.Text)) + "）。"); }
            else FitNativeText(frame, Number(e,"w"), Number(e,"h"), Number(e,"fontSize",22), slideNumber, Number(e, "minFontSize", 0));
            return shape;
        }

        private static string ResolveFont(string requested, string fallback)
        {
            string resolved;
            if (ResolvedFonts.TryGetValue(requested,out resolved)) return resolved;
            if (InstalledFonts.Contains(requested)) resolved=requested;
            else
            {
                resolved=InstalledFonts.Contains(fallback)?fallback:InstalledFonts.Contains("Yu Gothic")?"Yu Gothic":InstalledFonts.Contains("Meiryo")?"Meiryo":"Arial";
                Warnings.Add("書体「"+requested+"」がこのPCにないため「"+resolved+"」で描画しました。");
            }
            ResolvedFonts[requested]=resolved;
            return resolved;
        }

        private static void FitNativeText(dynamic frame, float width, float height, float requested, int slideNumber, float allowedMinimum = 0)
        {
            dynamic range = frame.TextRange;
            float minimum = allowedMinimum > 0 ? Math.Min(requested, allowedMinimum) : requested >= 27 ? Math.Max(24, requested * .8f) : requested >= 17 ? 17 : requested;
            float availableWidth = width - (float)frame.MarginLeft - (float)frame.MarginRight;
            float availableHeight = height - (float)frame.MarginTop - (float)frame.MarginBottom;
            float size = requested;
            while (((float)range.BoundHeight > availableHeight + 1 || (float)range.BoundWidth > availableWidth + 1) && size > minimum)
            {
                size = Math.Max(minimum,size-1);
                range.Font.Size = size;
            }
            if ((float)range.BoundHeight > availableHeight + 1 || (float)range.BoundWidth > availableWidth + 1)
                throw new InvalidDataException("TEXT_FIT_REQUIRED: スライド " + slideNumber + " の文章が実際の文字枠に収まりません。文章を短くするか構図を変更してください（" + Short(Convert.ToString(range.Text)) + "）。");
        }

        private static void AddShape(dynamic slide, Dictionary<string, object> e)
        {
            string kind = Text(e, "shape", "rect");
            dynamic shape = slide.Shapes.AddShape(ShapeType(kind), Number(e, "x"), Number(e, "y"), Number(e, "w"), Number(e, "h"));
            string fill = Text(e, "fill", "#FFFFFF");
            if (fill == "none" || fill == "transparent") shape.Fill.Visible = 0;
            else
            {
                shape.Fill.Visible = -1; shape.Fill.Solid(); shape.Fill.ForeColor.RGB = Color(fill);
                if (e.ContainsKey("opacity")) shape.Fill.Transparency = (float)Math.Max(0, Math.Min(1, 1 - Number(e, "opacity", 1)));
            }
            // Corner radius of a rounded rectangle, as a share of the shorter side (0-0.5).
            if (kind == "roundRect" && e.ContainsKey("radius")) { try { shape.Adjustments[1] = (float)Math.Max(0, Math.Min(.5f, Number(e, "radius", .1f))); } catch { } }
            string stroke = Text(e, "stroke", "none");
            if (stroke == "none" || stroke == "transparent") shape.Line.Visible = 0;
            else { shape.Line.Visible = -1; shape.Line.ForeColor.RGB = Color(stroke); shape.Line.Weight = Number(e, "strokeWidth", 1); }
            if (e.ContainsKey("rotation")) shape.Rotation = Number(e, "rotation");
            Release((object)shape);
        }

        /// <summary>Inserts SVG artwork (or PNG data) as a picture. The file is written next to the output and removed.</summary>
        private static void AddImage(dynamic slide, Dictionary<string, object> e, string output, int slideNumber)
        {
            string svg = Text(e, "svg", null), png = Text(e, "png", null);
            if (string.IsNullOrEmpty(svg) && string.IsNullOrEmpty(png)) return;
            string file = Path.Combine(output, "image-" + slideNumber + "-" + Guid.NewGuid().ToString("N") + (svg != null ? ".svg" : ".png"));
            if (svg != null) File.WriteAllText(file, svg, new UTF8Encoding(false)); else File.WriteAllBytes(file, Convert.FromBase64String(png));
            try { dynamic picture = slide.Shapes.AddPicture(file, 0, -1, Number(e, "x"), Number(e, "y"), Number(e, "w"), Number(e, "h")); Release((object)picture); }
            finally { try { File.Delete(file); } catch { } }
        }

        /// <summary>msoAutoShapeType for the shapes an AI-designed slide may use.</summary>
        private static int ShapeType(string kind)
        {
            switch (kind)
            {
                case "roundRect": return 5; case "ellipse": return 9; case "triangle": return 7; case "arrow": return 33;
                case "leftArrow": return 34; case "upArrow": return 35; case "downArrow": return 36; case "chevron": return 52;
                case "pentagon": return 51; case "hexagon": return 10; case "diamond": return 4; case "parallelogram": return 2;
                case "trapezoid": return 3; case "octagon": return 6; case "donut": return 18; default: return 1;
            }
        }

        private static void AddLine(dynamic slide, Dictionary<string, object> e)
        {
            float y = Number(e,"y"), h = Number(e,"h");
            dynamic shape = slide.Shapes.AddLine(Number(e, "x"), y + (Boolean(e,"flipY") ? h : 0), Number(e, "x") + Number(e, "w"), y + (Boolean(e,"flipY") ? 0 : h));
            shape.Line.ForeColor.RGB = Color(Text(e, "stroke", "#D7DEE5"));
            shape.Line.Weight = Number(e, "strokeWidth", 1);
            if (Boolean(e, "arrow")) shape.Line.EndArrowheadStyle = 3;
            if (Boolean(e, "arrowStart")) shape.Line.BeginArrowheadStyle = 3;
            if (Boolean(e, "dash")) shape.Line.DashStyle = 4;
            Release((object)shape);
        }

        private static void AddChart(dynamic slide, Dictionary<string, object> e, int slideNumber)
        {
            string type = Text(e, "chartType", "column");
            int chartType;
            switch (type) {
                case "bar": chartType = 57; break; case "column": chartType = 51; break;
                case "line": chartType = 65; break; case "pie": chartType = 5; break;
                case "doughnut": chartType = -4120; break; case "stackedBar": chartType = 58; break;
                case "stackedColumn": chartType = 52; break;
                default: throw new InvalidDataException("未登録のグラフ形式です。");
            }
            bool share = type == "pie" || type == "doughnut", stacked = type == "stackedBar" || type == "stackedColumn";
            object[] categories = ArrayOf(e, "categories"), series = ArrayOf(e, "series"), colors = ArrayOf(e, "colors");
            if (categories.Length == 0 || series.Length == 0 || categories.Length > 40 || series.Length > 8)
                throw new InvalidDataException("グラフは1〜40項目、1〜8系列にしてください。");
            if (share && series.Length != 1) throw new InvalidDataException("円・ドーナツグラフは1系列のみ使用できます。");
            if (stacked && series.Length < 2) throw new InvalidDataException("積み上げグラフは2系列以上が必要です。");
            Stage = "スライド " + slideNumber + " のグラフ挿入";
            dynamic shape = slide.Shapes.AddChart2(-1, chartType, Number(e, "x"), Number(e, "y"), Number(e, "w"), Number(e, "h"), false);
            dynamic chart = shape.Chart;
            dynamic workbook = null, chartData = null, sheet = null;
            try
            {
                Stage = "スライド " + slideNumber + " のグラフデータの初期化";
                chartData = chart.ChartData;
                // Embedded Excel can still be starting or releasing the preceding
                // deck. Retry only its idempotent activation, never a data write.
                for (int attempt = 0; ; attempt++)
                {
                    try { chartData.Activate(); workbook = chartData.Workbook; dynamic sheets = workbook.Worksheets; sheet = sheets.Item(1); Release((object)sheets); break; }
                    catch (COMException ex)
                    {
                        if (attempt >= 3 || (ex.ErrorCode != unchecked((int)0x80004005) && ex.ErrorCode != unchecked((int)0x80010001) && ex.ErrorCode != unchecked((int)0x8001010A) && ex.ErrorCode != unchecked((int)0x80010108) && ex.ErrorCode != unchecked((int)0x800401FD))) throw;
                        Release((object)sheet); sheet = null;
                        Release((object)workbook); workbook = null;
                        Release((object)chartData); chartData = chart.ChartData;
                        Thread.Sleep(500 * (attempt + 1));
                    }
                }
                Stage = "スライド " + slideNumber + " のグラフデータの書き込み";
                // Only the chart's small data rectangle is needed. Do not clear the
                // entire Excel sheet while its embedded chart is actively rendering.
                Stage = "スライド " + slideNumber + " のグラフデータ配列の準備";
                var values = new object[categories.Length + 1, series.Length + 1];
                values[0, 0] = "項目";
                for (int row = 0; row < categories.Length; row++) values[row + 1, 0] = ExcelText(Convert.ToString(categories[row]));
                for (int col = 0; col < series.Length; col++)
                {
                    var s = AsObject(series[col]);
                    values[0, col + 1] = ExcelText(Text(s, "name", "系列 " + (col + 1)));
                    object[] numbers = ArrayOf(s, "values");
                    if (numbers.Length != categories.Length) throw new InvalidDataException("グラフのラベルと値の件数が一致しません。");
                    for (int row = 0; row < numbers.Length; row++)
                    {
                        if (numbers[row] == null) throw new InvalidDataException("グラフの値に欠損があります。0として補完しないでください。");
                        double value = Convert.ToDouble(numbers[row], CultureInfo.InvariantCulture);
                        if (Double.IsNaN(value) || Double.IsInfinity(value)) throw new InvalidDataException("グラフの数値が無効です。");
                        if ((share || stacked) && value < 0) throw new InvalidDataException("内訳グラフに負の値は使用できません。");
                        values[row + 1, col + 1] = value;
                    }
                }
                if (share) { double total = 0; for (int r = 1; r <= categories.Length; r++) total += Convert.ToDouble(values[r,1]); if (!(total > 0) || Double.IsInfinity(total)) throw new InvalidDataException("円・ドーナツグラフの合計は正の有限値が必要です。"); }
                if (stacked) for (int r = 1; r <= categories.Length; r++) { double total = 0; for (int c = 1; c <= series.Length; c++) total += Convert.ToDouble(values[r,c]); if (Double.IsInfinity(total)) throw new InvalidDataException("積み上げの合計が無効です。"); }
                string endColumn = ((char)('A' + series.Length)).ToString();
                string range = "$A$1:$" + endColumn + "$" + (categories.Length + 1).ToString(CultureInfo.InvariantCulture);
                Stage = "スライド " + slideNumber + " のグラフのセル入力";
                dynamic dataRange = sheet.Range[range];
                try { dataRange.Value2 = values; } finally { Release((object)dataRange); }
                Stage = "スライド " + slideNumber + " のグラフ範囲の指定";
                chart.SetSourceData("'" + ((string)sheet.Name).Replace("'", "''") + "'!" + range, 2);
                // Cell references and saved caches are synchronized after Excel has
                // committed; avoid separately rebinding live embedded series here.
                Stage = "スライド " + slideNumber + " のグラフ書式設定";
                chart.HasTitle = false;
                chart.HasLegend = series.Length > 1 || share;
                chart.ChartArea.Format.Fill.Visible = 0;
                chart.ChartArea.Format.Line.Visible = 0;
                chart.PlotArea.Format.Fill.Visible = 0;
                chart.PlotArea.Format.Line.Visible = 0;
                chart.ChartArea.Font.Name = FontName;
                chart.ChartArea.Font.Size = Number(e, "labelSize", 14);
                chart.ChartArea.Font.Color = Foreground;
                if (chart.HasLegend) { chart.Legend.Position = -4107; chart.Legend.Font.Size = Number(e,"labelSize",14); }
                if (type == "doughnut") { Stage = "スライド " + slideNumber + " のドーナツ穴の設定"; dynamic group = chart.ChartGroups(1); group.DoughnutHoleSize = 42; Release((object)group); }
                for (int i = 1; i <= series.Length; i++)
                {
                    dynamic s = chart.SeriesCollection(i);
                    int color = colors.Length > 0 ? Color(Convert.ToString(colors[(i - 1) % colors.Length])) : Accent;
                    if (type == "line") { s.Format.Line.ForeColor.RGB = color; s.Format.Line.Weight = 2.5; s.MarkerStyle = 8; s.MarkerSize = 7; s.MarkerForegroundColor = color; s.MarkerBackgroundColor = color; s.Smooth = false; }
                    else { s.Format.Fill.Solid(); s.Format.Fill.ForeColor.RGB = color; s.Format.Line.Visible = 0; }
                    if (share) for (int p = 1; p <= categories.Length; p++)
                    {
                        dynamic point = s.Points(p);
                        point.Format.Fill.ForeColor.RGB = colors.Length > 0 ? Color(Convert.ToString(colors[(p - 1) % colors.Length])) : Accent;
                        point.Format.Line.Visible = -1; point.Format.Line.ForeColor.RGB = Color(Text(e,"background","#FFFFFF")); point.Format.Line.Weight = 1.5;
                        Release((object)point);
                    }
                    // Editable native labels; never replace the underlying values with rounded ones.
                    if (Boolean(e,"showValues")) {
                        Stage = "スライド " + slideNumber + " のデータラベル追加";
                        s.ApplyDataLabels(); dynamic labels = s.DataLabels();
                        Stage = "スライド " + slideNumber + " のデータラベルの内容設定";
                        labels.ShowValue = !share; labels.ShowPercentage = share; labels.ShowCategoryName = false; labels.ShowSeriesName = false;
                        bool fractional = false; foreach (object number in ArrayOf(AsObject(series[i-1]),"values")) { double v = Convert.ToDouble(number); if (v != Math.Truncate(v)) fractional = true; }
                        labels.NumberFormatLinked = false; labels.NumberFormat = share ? "0.0%" : fractional ? "General" : "#,##0";
                        Stage = "スライド " + slideNumber + " のデータラベルの位置設定";
                        // Doughnut charts do not accept Center on every Office version.
                        if (type != "doughnut") labels.Position = share || stacked ? -4108 : type == "line" ? 0 : 2;
                        Stage = "スライド " + slideNumber + " のデータラベルの文字設定";
                        labels.Font.Name = FontName; labels.Font.Size = Number(e,"labelSize",14); labels.Font.Bold = true;
                        labels.Font.Color = stacked ? LabelInk(color) : Foreground;
                        double labelTotal = 0; if (share) for (int r = 1; r <= categories.Length; r++) labelTotal += Convert.ToDouble(values[r,1]);
                        if (share) for (int p = 1; p <= categories.Length; p++) {
                            Stage = "スライド " + slideNumber + " の内訳ラベル " + p + " の文字色設定";
                            dynamic point = s.Points(p);
                            int pointColor = colors.Length > 0 ? Color(Convert.ToString(colors[(p-1)%colors.Length])) : Accent;
                            // Narrow slices cannot hold a legible percentage. Keep
                            // their legend/data and omit only the overlapping label.
                            if (Convert.ToDouble(values[p,1])/labelTotal < 0.055) point.HasDataLabel = false;
                            else point.DataLabel.Font.Color = LabelInk(pointColor);
                            Release((object)point);
                        }
                        Release((object)labels);
                    } else { s.HasDataLabels = false; }
                    Release((object)s);
                }
                if (!share)
                {
                    dynamic valueAxis = chart.Axes(2, 1);
                    valueAxis.HasMajorGridlines = true;
                    valueAxis.MajorGridlines.Format.Line.ForeColor.RGB = Color(Text(e,"gridColor","#E3E8EE"));
                    // Thousands separators on the scale ("2,500,000", not "2500000").
                    bool fractionalScale = false; foreach (object item in series) foreach (object number in ArrayOf(AsObject(item),"values")) { double v = Convert.ToDouble(number); if (v != Math.Truncate(v)) fractionalScale = true; }
                    valueAxis.TickLabels.NumberFormat = fractionalScale ? "#,##0.0" : "#,##0";
                    valueAxis.TickLabels.Font.Color = Foreground; valueAxis.TickLabels.Font.Size = Number(e,"labelSize",14);
                    valueAxis.TickLabelPosition = -4134;
                    dynamic categoryAxis = chart.Axes(1,1); categoryAxis.TickLabels.Font.Color = Foreground; categoryAxis.TickLabels.Font.Size = Number(e,"labelSize",14); categoryAxis.TickLabelSpacing = 1; categoryAxis.TickLabelPosition = -4134;
                    // Category names stay horizontal and wrap instead of being turned diagonally.
                    categoryAxis.TickLabels.Orientation = -4128;
                    Release((object)categoryAxis);
                    string unit = Text(e, "unit", "");
                    if (unit.Length > 0) { valueAxis.HasTitle = true; valueAxis.AxisTitle.Text = unit; valueAxis.AxisTitle.Font.Size = 12; }
                    // Column/bar lengths should have an honest zero baseline unless negatives require an automatic range.
                    if (type == "bar" || type == "column" || stacked)
                    {
                        bool negative = false;
                        for (int c = 1; c <= series.Length; c++) for (int r = 1; r <= categories.Length; r++)
                            if (Convert.ToDouble(values[r, c]) < 0) negative = true;
                        if (!negative) valueAxis.MinimumScale = 0;
                    }
                    Release((object)valueAxis);
                }
                // Closing the embedded workbook commits its values. Forcing Refresh here
                // can disconnect the embedded Excel server while it is still editing.
                Stage = "スライド " + slideNumber + " のグラフデータの保存";
                workbook.Close(true);
                Release((object)sheet); sheet = null;
                Release((object)workbook); workbook = null;
            }
            finally
            {
                Release((object)sheet);
                if ((object)workbook != null) { try { workbook.Close(true); } catch { } Release((object)workbook); }
                Release((object)chartData);
                Release((object)chart); Release((object)shape);
            }
        }

        private static void AddSmartArt(dynamic app, dynamic slide, Dictionary<string, object> e, int slideNumber)
        {
            string requested = Text(e, "layout", "process");
            string[] ids = requested == "cycle" ? new[] { "cycle1", "basicCycle" } : requested == "hierarchy" ? new[] { "hierarchy1", "orgChart1", "hierarchy" } : requested == "list" ? new[] { "vList5" } : new[] { "process1", "basicProcess" };
            dynamic layout = null;
            for (int i = 1; i <= (int)app.SmartArtLayouts.Count; i++)
            {
                dynamic candidate = app.SmartArtLayouts.Item(i);
                string id = Convert.ToString(candidate.Id);
                bool match = false;
                foreach (string key in ids) if (id.IndexOf("/" + key + "#", StringComparison.OrdinalIgnoreCase) >= 0 || id.EndsWith("/" + key, StringComparison.OrdinalIgnoreCase)) match = true;
                if (match) { layout = candidate; break; }
                Release((object)candidate);
            }
            if (layout == null)
            {
                Warnings.Add("スライド " + slideNumber + ": 対応するSmartArtが見つからないため、編集可能な通常図形で表示しました。");
                SmartArtFallback(slide, e, slideNumber);
                return;
            }
            object[] items = ArrayOf(e, "items");
            if (items.Length == 0 || items.Length > 10) throw new InvalidDataException("SmartArtは1〜10項目にしてください。");
            dynamic shape = slide.Shapes.AddSmartArt(layout, Number(e, "x"), Number(e, "y"), Number(e, "w"), Number(e, "h"));
            dynamic art = shape.SmartArt;
            while ((int)art.AllNodes.Count > 1) art.AllNodes.Item((int)art.AllNodes.Count).Delete();
            var nodes = new List<object>();
            nodes.Add(art.AllNodes.Item(1));
            for (int i = 1; i < items.Length; i++)
            {
                var item = AsObject(items[i]);
                dynamic previous;
                if (requested == "hierarchy")
                {
                    int parent = (int)Number(item, "parent", 0);
                    if (parent < 0 || parent >= i) throw new InvalidDataException("階層の親は前に定義された項目を参照してください。");
                    previous = nodes[parent];
                    nodes.Add(previous.AddNode(5, 1));
                }
                else { previous = nodes[i - 1]; nodes.Add(previous.AddNode(2, 1)); }
            }
            int nodeColor = Color(Text(e, "accent", null), Accent);
            for (int i = 0; i < items.Length; i++)
            {
                dynamic node = nodes[i];
                var item = AsObject(items[i]);
                string description = Text(item, "description", "");
                node.TextFrame2.TextRange.Text = Text(item, "label", "") + (description.Length > 0 ? "\n" + description : "");
                node.TextFrame2.TextRange.Font.Name = FontName;
                node.TextFrame2.TextRange.Font.NameFarEast = FontName;
                node.TextFrame2.TextRange.Font.Size = Number(e, "fontSize", 18);
                node.TextFrame2.TextRange.Font.Fill.ForeColor.RGB = Color(Text(e, "color", "#FFFFFF"));
                for (int s = 1; s <= (int)node.Shapes.Count; s++)
                {
                    dynamic nodeShape = node.Shapes.Item(s);
                    try { nodeShape.Fill.Solid(); nodeShape.Fill.ForeColor.RGB = nodeColor; nodeShape.Line.Visible = 0; } catch { }
                    Release((object)nodeShape);
                }
            }
            // Check after all nodes are populated because SmartArt reflows as nodes are added.
            foreach (object itemNode in nodes)
            {
                dynamic node = itemNode;
                float width = 0, height = 0;
                for (int s = 1; s <= (int)node.Shapes.Count; s++)
                {
                    dynamic nodeShape = node.Shapes.Item(s);
                    width = Math.Max(width,(float)nodeShape.Width);
                    height = Math.Max(height,(float)nodeShape.Height);
                    Release((object)nodeShape);
                }
                FitNativeText(node.TextFrame2,width,height,Number(e,"fontSize",18),slideNumber);
                Release(itemNode);
            }
            Release((object)art); Release((object)shape); Release((object)layout);
        }

        private static void SmartArtFallback(dynamic slide, Dictionary<string, object> e, int slideNumber)
        {
            object[] items = ArrayOf(e, "items");
            if (items.Length == 0) return;
            float gap = 16, width = (Number(e, "w") - gap * (items.Length - 1)) / items.Length;
            for (int i = 0; i < items.Length; i++)
            {
                var item = AsObject(items[i]);
                var box = new Dictionary<string, object> {
                    {"x", Number(e,"x") + i * (width+gap)}, {"y",Number(e,"y")}, {"w",width}, {"h",Number(e,"h")},
                    {"shape","roundRect"}, {"fill",Text(e,"accent","#087F8C")}, {"stroke","none"}
                };
                AddShape(slide, box);
                box["text"] = Text(item, "label", "") + (Text(item, "description", "").Length > 0 ? "\n" + Text(item, "description", "") : "");
                box["fontSize"] = Number(e, "fontSize", 18); box["color"] = Text(e, "color", "#FFFFFF"); box["align"] = "center"; box["padding"] = 12;
                AddText(slide, box, slideNumber);
            }
        }

        private static void WriteNotes(dynamic slide, string text)
        {
            bool found = false;
            for (int i = 1; i <= (int)slide.NotesPage.Shapes.Count; i++)
            {
                dynamic shape = slide.NotesPage.Shapes.Item(i);
                try { if ((int)shape.Type == 14 && (int)shape.PlaceholderFormat.Type == 2) { shape.TextFrame.TextRange.Text = text; found = true; } } catch { }
                Release((object)shape);
            }
            if (!found && text.Length > 0) { dynamic box = slide.NotesPage.Shapes.AddTextbox(1, 36, 320, 640, 260); box.TextFrame.TextRange.Text = text; Release(box); }
        }

        private static string ExcelText(string text)
        {
            // Data labels must stay data even when supplied by a spreadsheet or LLM.
            if (text.Length > 0 && "=+-@\t\r".IndexOf(text[0]) >= 0) return "'" + text;
            return text;
        }
        private static int LabelInk(int officeColor) {
            // Office stores RGB in BGR order; choose white/dark by relative luminance.
            double[] channels = { (officeColor & 255) / 255.0, ((officeColor >> 8) & 255) / 255.0, ((officeColor >> 16) & 255) / 255.0 };
            for (int i = 0; i < 3; i++) channels[i] = channels[i] <= .04045 ? channels[i]/12.92 : Math.Pow((channels[i]+.055)/1.055,2.4);
            double light = .2126*channels[0]+.7152*channels[1]+.0722*channels[2];
            return light < .179 ? Color("#FFFFFF") : Color("#172D4A");
        }
        private static string Short(string text) { return text.Length > 28 ? text.Substring(0, 28) + "…" : text; }
        private static Dictionary<string, object> AsObject(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
        private static Dictionary<string, object> ObjectOf(Dictionary<string, object> d, string key) { object v; return d.TryGetValue(key, out v) ? AsObject(v) : new Dictionary<string, object>(); }
        private static object[] ArrayOf(Dictionary<string, object> d, string key)
        {
            object v; if (!d.TryGetValue(key, out v) || v == null) return new object[0];
            var a = v as object[]; if (a != null) return a;
            var list = v as ArrayList; return list == null ? new object[0] : list.ToArray();
        }
        private static string Text(Dictionary<string, object> d, string key, string fallback) { object v; return d.TryGetValue(key, out v) && v != null ? Convert.ToString(v, CultureInfo.InvariantCulture) : fallback; }
        private static float Number(Dictionary<string, object> d, string key, float fallback = 0) { object v; return d.TryGetValue(key, out v) && v != null ? Convert.ToSingle(v, CultureInfo.InvariantCulture) : fallback; }
        private static bool Boolean(Dictionary<string, object> d, string key) { object v; return d.TryGetValue(key, out v) && v is bool && (bool)v; }
        private static int Color(string text, int fallback = 0)
        {
            if (String.IsNullOrEmpty(text)) return fallback;
            string s = text.TrimStart('#');
            int rgb;
            if (s.Length != 6 || !Int32.TryParse(s, NumberStyles.HexNumber, CultureInfo.InvariantCulture, out rgb)) throw new InvalidDataException("色は#RRGGBB形式で指定してください。");
            return ((rgb & 255) << 16) | (rgb & 65280) | ((rgb >> 16) & 255);
        }
        private static void Release(object value) { if (value != null && Marshal.IsComObject(value)) try { Marshal.ReleaseComObject(value); } catch { } }
    }

    [ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IOleMessageFilter
    {
        [PreserveSig] int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo);
        [PreserveSig] int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType);
        [PreserveSig] int MessagePending(IntPtr taskCallee, int tickCount, int pendingType);
    }
    internal sealed class OleMessageFilter : IOleMessageFilter
    {
        [DllImport("ole32.dll")] private static extern int CoRegisterMessageFilter(IOleMessageFilter filter, out IOleMessageFilter oldFilter);
        public static void Register() { IOleMessageFilter old; CoRegisterMessageFilter(new OleMessageFilter(), out old); }
        public static void Revoke() { IOleMessageFilter old; CoRegisterMessageFilter(null, out old); }
        public int HandleInComingCall(int callType, IntPtr taskCaller, int tickCount, IntPtr interfaceInfo) { return 0; }
        public int RetryRejectedCall(IntPtr taskCallee, int tickCount, int rejectType) { return (rejectType == 1 || rejectType == 2) && tickCount < 15000 ? 150 : -1; }
        public int MessagePending(IntPtr taskCallee, int tickCount, int pendingType) { return 2; }
    }
}
