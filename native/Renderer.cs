using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Xml;

namespace DesignerExtension.Native
{
    // This executable accepts data only. It never evaluates generated code or macros.
    internal static class Renderer
    {
        private static readonly List<string> Warnings = new List<string>();
        // Text PowerPoint set differently from the plan (past its box, over another text, into a chevron's cut-in),
        // listed for the app to show once the deck is made.
        private static readonly List<Dictionary<string, object>> Issues = new List<Dictionary<string, object>>();
        private static string FontName = "Yu Gothic", HeadingFont = "Yu Gothic";
        // The deck's own theme colours, as the theme colour (ObjectThemeColor) each is written as; none for a deck
        // that takes a company template's theme.
        private static readonly Dictionary<int, int> ThemeColors = new Dictionary<int, int>();
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
            if (args.Length == 1 && (args[0] == "--protect" || args[0] == "--unprotect")) return Protect(args[0] == "--protect");
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
                HeadingFont = ResolveFont(Text(theme, "headingFont", FontName), FontName);
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
                bool themed = false;
                try
                {
                    dynamic look = presentation.SlideMaster.Theme;
                    dynamic scheme = look.ThemeColorScheme;
                    // The deck's colours and fonts are its theme's, which its shapes and texts refer to (Design >
                    // Variants restyles the deck); slides show the master's background (Background 1).
                    object[] colors = ArrayOf(scene, "themeColors");
                    int[] slots = { 13, 14, 15, 16, 5, 6, 7, 8, 9, 10 }; // Text 1, Background 1, Text 2, Background 2, Accent 1-6
                    for (int k = 0; k < colors.Length && k < 10; k++)
                    {
                        int rgb = Color(Convert.ToString(colors[k], CultureInfo.InvariantCulture));
                        scheme.Colors(k + 1).RGB = rgb;
                        if (!ThemeColors.ContainsKey(rgb)) ThemeColors[rgb] = slots[k];
                    }
                    // A company template's deck takes that deck's theme when inserted; its own file keeps the look.
                    if (colors.Length == 0) { scheme.Colors(1).RGB = Foreground; scheme.Colors(2).RGB = Color(Text(theme, "background", "#FFFFFF")); scheme.Colors(5).RGB = Accent; }
                    LoadThemeFonts(look.ThemeFontScheme, output);
                    themed = true;
                }
                catch { ThemeColors.Clear(); Warnings.Add("テーマの一部は図形ごとの書式で適用しました。"); }
                var thumbs = new List<string>();
                for (int i = 0; i < slides.Length; i++)
                {
                    var data = AsObject(slides[i]);
                    Stage = "スライド " + (i + 1) + " の作成";
                    // Title Only: the slide's title is written in its title placeholder.
                    dynamic slide = presentation.Slides.Add(i + 1, 11);
                    string ground = Text(data, "background", themed ? null : Text(theme, "background", "#FFFFFF"));
                    if (ground != null) { slide.FollowMasterBackground = 0; slide.Background.Fill.Solid(); Paint(slide.Background.Fill.ForeColor, Color(ground)); }
                    try { slide.Name = "DE_" + (i + 1).ToString(CultureInfo.InvariantCulture); } catch { }
                    dynamic lastShape = null;
                    bool titled = false;
                    var groups = new Dictionary<string, List<string>>();
                    var boxes = new List<string>(); var glued = new Dictionary<string, Dictionary<string, object>>();
                    foreach (object element in ArrayOf(data, "elements"))
                    {
                        var e = AsObject(element);
                        string kind = Text(e, "kind", "");
                        Stage = "スライド " + (i + 1) + " の " + kind + " の配置";
                        ValidateBounds(e, i + 1);
                        int before = slide.Shapes.Count;
                        dynamic shape = null;
                        // The one text of a box drawn just before it is written in that shape.
                        if (kind == "text" && e.ContainsKey("inShape") && lastShape != null) AddLabel(lastShape, e);
                        else if (kind == "text" && Boolean(e, "title") && !titled && (int)slide.Shapes.HasTitle != 0) { AddText(slide, e, i + 1, slide.Shapes.Title); titled = true; }
                        else if (kind == "text") AddText(slide, e, i + 1);
                        else if (kind == "shape") { shape = AddShape(slide, e); boxes.Add(Convert.ToString(shape.Name)); }
                        else if (kind == "line") { string name = AddLine(slide, e); if (e.ContainsKey("from") || e.ContainsKey("to")) glued[name] = e; }
                        else if (kind == "chart") AddChart(slide, e, i + 1);
                        else if (kind == "table") AddTable(slide, e, i + 1);
                        else if (kind == "smartart") AddSmartArt(app, slide, e, i + 1);
                        else if (kind == "image") AddImage(slide, e, output, i + 1);
                        else throw new InvalidDataException("Unknown element kind: " + kind);
                        Release((object)lastShape); lastShape = shape;
                        Collect(slide, groups, Text(e, "group", null), before);
                    }
                    Release((object)lastShape);
                    if (!titled && (int)slide.Shapes.HasTitle != 0) slide.Shapes.Title.Delete();
                    Stage = "スライド " + (i + 1) + " の文字の重なりの確認";
                    CheckTextLayout(slide, i + 1);
                    foreach (var line in glued) Glue(slide, line.Key, line.Value, boxes);
                    GroupShapes(slide, groups);
                    // A group takes the place of its top part, and the title cannot join one: a card grouped with the text under the title would cover it.
                    if (titled) slide.Shapes.Title.ZOrder(0);
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
                Stage = "作成者情報の消去";
                ReplaceAuthor(pptx);
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
                    pptx = "presentation.pptx", thumbnails = thumbs, warnings = Warnings, issues = Issues, native = true
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

        // DPAPI for the app's keys (the history key, the ChatGPT login): only this Windows user can
        // unwrap them. Base64 comes in on stdin and goes out on stdout, never on the command line.
        private static int Protect(bool protect)
        {
            try
            {
                byte[] input = Convert.FromBase64String(Console.In.ReadToEnd().Trim());
                byte[] result = protect
                    ? ProtectedData.Protect(input, null, DataProtectionScope.CurrentUser)
                    : ProtectedData.Unprotect(input, null, DataProtectionScope.CurrentUser);
                Console.Out.Write(Convert.ToBase64String(result));
                return 0;
            }
            catch (Exception ex) { Console.Error.WriteLine(ex.GetType().Name); return 1; }
        }

        // Office saves the signed-in account's name as author and last editor. A deck
        // made here goes out under the app's name, as the no-install version's does.
        private static void ReplaceAuthor(string pptx)
        {
            using (var zip = ZipFile.Open(pptx, ZipArchiveMode.Update))
            {
                var entry = zip.GetEntry("docProps/core.xml");
                if (entry == null) return;
                var doc = new XmlDocument { XmlResolver = null };
                using (var stream = entry.Open())
                using (var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null })) doc.Load(reader);
                foreach (string name in new[] { "creator", "lastModifiedBy" })
                    foreach (XmlNode node in doc.GetElementsByTagName(name, "*")) node.InnerText = "Designer Extension";
                using (var stream = entry.Open())
                {
                    stream.SetLength(0);
                    using (var writer = XmlWriter.Create(stream, new XmlWriterSettings { Encoding = new UTF8Encoding(false) })) doc.Save(writer);
                }
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
                Console.WriteLine("Designer Extension add-in is connected.");
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

        private static dynamic AddText(dynamic slide, Dictionary<string, object> e, int slideNumber, dynamic title = null)
        {
            float x = Number(e, "x"), y = Number(e, "y"), w = Number(e, "w"), h = Number(e, "h");
            dynamic shape = title;
            if ((object)title == null) shape = slide.Shapes.AddTextbox(1, x, y, w, h);
            // The title placeholder is put where the title was drawn, over what was drawn before it.
            else { shape.Left = x; shape.Top = y; shape.Width = w; shape.Height = h; shape.ZOrder(0); }
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
            TextLook(range, e, Text(e, "font", FontName), Text(e, "fontFarEast", Text(e, "font", FontName)));
            // The master's title style (90% line spacing; capitals in some templates) does not change the title.
            if ((object)title != null)
            {
                if (!e.ContainsKey("lineHeight")) { range.ParagraphFormat.LineRuleWithin = -1; range.ParagraphFormat.SpaceWithin = 1; }
                range.ParagraphFormat.SpaceBefore = 0;
                range.Font.Allcaps = 0;
            }
            // The leading number is the slide's own: a field PowerPoint keeps right when slides move.
            if (Boolean(e, "slideNumber"))
            {
                string text = Convert.ToString(range.Text);
                int digits = text.Length - text.TrimStart("0123456789".ToCharArray()).Length;
                if (digits > 0) { range.Text = text.Substring(digits); shape.TextFrame.TextRange.Characters(1, 0).InsertSlideNumber(); }
            }
            // Browser-measured text keeps its lines; only report if PowerPoint sets it wider. BoundWidth runs up to a
            // quarter of the size past the characters whatever their number ("4.8" at 130: 24pt wider, its ink is not).
            // Browser-measured text keeps its lines; CheckTextLayout looks at it once the slide is complete.
            if (!Boolean(e, "exact")) FitNativeText(frame, w, h, Number(e,"fontSize",22), slideNumber, Number(e, "minFontSize", 0));
            return shape;
        }

        /// <summary>A text's words and look: font, size, weight, colour, alignment, coloured or bold parts (runs) and a
        /// fixed line pitch, for a text box or a table cell.</summary>
        private static void TextLook(dynamic range, Dictionary<string, object> e, string font, string farEast)
        {
            range.Text = Text(e, "text", "");
            bool heading = Boolean(e, "title") || Text(e, "role", "") == "heading";
            range.Font.Name = ThemeFont(ResolveFont(font, FontName), "lt", heading);
            range.Font.NameFarEast = ThemeFont(ResolveFont(farEast, FontName), "ea", heading);
            range.Font.Size = Number(e, "fontSize", 22);
            range.Font.Bold = Boolean(e, "bold") ? -1 : 0;
            range.Font.Italic = Boolean(e, "italic") ? -1 : 0;
            Paint(range.Font.Fill.ForeColor, Color(Text(e, "color", null), Foreground));
            string align = Text(e, "align", "left");
            range.ParagraphFormat.Alignment = align == "center" ? 2 : align == "right" ? 3 : 1;
            range.ParagraphFormat.SpaceAfter = Number(e, "paragraphSpacing", 0);
            if (e.ContainsKey("spacing")) range.Font.Spacing = Number(e, "spacing", 0);
            // Parts of the text with their own colour or weight (from an HTML page).
            foreach (object item in ArrayOf(e, "runs"))
            {
                var run = item as Dictionary<string, object>;
                if (run == null) continue;
                int start = (int)Number(run, "start"), length = (int)Number(run, "length");
                if (length <= 0) continue;
                try
                {
                    dynamic part = range.Characters(start + 1, length);
                    if (run.ContainsKey("color")) Paint(part.Font.Fill.ForeColor, Color(Text(run, "color", null), Foreground));
                    if (run.ContainsKey("bold")) part.Font.Bold = Boolean(run, "bold") ? -1 : 0;
                    if (run.ContainsKey("italic")) part.Font.Italic = Boolean(run, "italic") ? -1 : 0;
                    Release((object)part);
                }
                catch { }
            }
            // Fixed line pitch (points between baselines) for text laid out by a browser.
            if (e.ContainsKey("lineHeight")) { range.ParagraphFormat.LineRuleWithin = 0; range.ParagraphFormat.SpaceWithin = Number(e, "lineHeight", 0); }
        }

        /// <summary>A PowerPoint table: column widths and row heights, and each cell's text, fill, borders and margins.
        /// It has no table style of its own (every look comes from its cells); its heading row is marked as one.</summary>
        private static void AddTable(dynamic slide, Dictionary<string, object> e, int slideNumber)
        {
            object[] columns = ArrayOf(e, "columns"), rows = ArrayOf(e, "rows"), cells = ArrayOf(e, "cells");
            if (columns.Length < 1 || columns.Length > 12 || rows.Length < 1 || rows.Length > 20 || cells.Length != rows.Length)
                throw new InvalidDataException("表の行と列の数が一致しません。");
            dynamic shape = slide.Shapes.AddTable(rows.Length, columns.Length, Number(e, "x"), Number(e, "y"), Number(e, "w"), Number(e, "h"));
            dynamic table = shape.Table;
            bool plain = true;
            try { table.ApplyStyle("{2D5ABB26-0587-4C30-8999-92F81FD0307C}", false); } catch { plain = false; }
            table.FirstRow = Boolean(e, "header") ? -1 : 0;
            table.HorizBanding = 0;
            for (int c = 0; c < columns.Length; c++) { dynamic column = table.Columns(c + 1); column.Width = Convert.ToSingle(columns[c], CultureInfo.InvariantCulture); Release((object)column); }
            string font = Text(e, "font", FontName), farEast = Text(e, "fontFarEast", font);
            int[] sides = { 1, 4, 3, 2 }; // top, right, bottom, left as ppBorderTop, ppBorderRight, ppBorderBottom, ppBorderLeft
            for (int r = 0; r < rows.Length; r++)
            {
                object[] row = cells[r] is object[] ? (object[])cells[r] : cells[r] is ArrayList ? ((ArrayList)cells[r]).ToArray() : new object[0];
                if (row.Length != columns.Length) throw new InvalidDataException("表の行と列の数が一致しません。");
                for (int c = 0; c < columns.Length; c++)
                {
                    Stage = "スライド " + slideNumber + " の表 " + (r + 1) + "行" + (c + 1) + "列";
                    var data = AsObject(row[c]);
                    dynamic cell = table.Cell(r + 1, c + 1);
                    dynamic s = cell.Shape;
                    string fill = Text(data, "fill", null);
                    if (fill == null) s.Fill.Visible = 0;
                    else
                    {
                        s.Fill.Visible = -1; s.Fill.Solid(); Paint(s.Fill.ForeColor, Color(fill));
                        if (data.ContainsKey("opacity")) s.Fill.Transparency = (float)Math.Max(0, Math.Min(1, 1 - Number(data, "opacity", 1)));
                    }
                    object[] borders = ArrayOf(data, "borders");
                    for (int b = 0; b < 4; b++)
                    {
                        var side = b < borders.Length ? borders[b] as Dictionary<string, object> : null;
                        if (side == null && plain) continue;
                        dynamic border = cell.Borders(sides[b]);
                        // A border set to none is written transparent (PowerPoint ignores Visible = false on table borders).
                        if (side == null) border.Transparency = 1;
                        else { border.Visible = -1; border.Transparency = 0; Paint(border.ForeColor, Color(Text(side, "color", "#000000"))); border.Weight = Number(side, "width", 1); }
                        Release((object)border);
                    }
                    dynamic frame = s.TextFrame2;
                    object[] margin = ArrayOf(data, "margin");
                    if (margin.Length == 4)
                    {
                        frame.MarginLeft = Convert.ToSingle(margin[0], CultureInfo.InvariantCulture); frame.MarginTop = Convert.ToSingle(margin[1], CultureInfo.InvariantCulture);
                        frame.MarginRight = Convert.ToSingle(margin[2], CultureInfo.InvariantCulture); frame.MarginBottom = Convert.ToSingle(margin[3], CultureInfo.InvariantCulture);
                    }
                    string vertical = Text(data, "verticalAlign", "top");
                    frame.VerticalAnchor = vertical == "middle" ? 3 : vertical == "bottom" ? 4 : 1;
                    // A browser's lines are kept as drawn: PowerPoint does not wrap them again.
                    if (Boolean(e, "noWrap")) { try { frame.WordWrap = 0; } catch { } }
                    dynamic range = frame.TextRange;
                    TextLook(range, data, font, farEast);
                    Release((object)range); Release((object)frame); Release((object)s); Release((object)cell);
                }
            }
            for (int r = 0; r < rows.Length; r++) { dynamic tableRow = table.Rows(r + 1); tableRow.Height = Convert.ToSingle(rows[r], CultureInfo.InvariantCulture); Release((object)tableRow); }
            Release((object)table); Release((object)shape);
        }

        /// <summary>A colour of the deck's theme is written as that theme colour (Design > Variants recolours it);
        /// any other as it is.</summary>
        private static void Paint(dynamic color, int rgb)
        {
            int slot;
            if (ThemeColors.TryGetValue(rgb, out slot)) color.ObjectThemeColor = slot; else color.RGB = rgb;
        }

        /// <summary>The deck's heading or body font as the theme's (+mj-, +mn-) when the deck has its own theme;
        /// any other font by name.</summary>
        private static string ThemeFont(string font, string script, bool heading)
        {
            if (ThemeColors.Count == 0) return font;
            if (font == (heading ? HeadingFont : FontName)) return (heading ? "+mj-" : "+mn-") + script;
            return font == HeadingFont ? "+mj-" + script : font == FontName ? "+mn-" + script : font;
        }

        /// <summary>The deck's heading and body fonts as the theme's, for Japanese text too (its script font is
        /// only set by loading a font scheme).</summary>
        private static void LoadThemeFonts(dynamic fonts, string folder)
        {
            Func<string, string> set = name =>
            {
                string font = System.Security.SecurityElement.Escape(name);
                return "<a:latin typeface=\"" + font + "\"/><a:ea typeface=\"" + font + "\"/><a:cs typeface=\"\"/><a:font script=\"Jpan\" typeface=\"" + font + "\"/>";
            };
            string file = Path.Combine(folder, "theme-fonts.xml");
            File.WriteAllText(file, "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><a:fontScheme xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" name=\"Designer Extension\"><a:majorFont>"
                + set(HeadingFont) + "</a:majorFont><a:minorFont>" + set(FontName) + "</a:minorFont></a:fontScheme>", new UTF8Encoding(false));
            try { fonts.Load(file); } finally { File.Delete(file); }
        }

        private static string ResolveFont(string requested, string fallback)
        {
            string resolved;
            if (ResolvedFonts.TryGetValue(requested,out resolved)) return resolved;
            if (InstalledFonts.Contains(requested)) resolved=requested;
            else
            {
                // A missing serif (明朝・Serif) falls back to an installed 明朝, anything else to the deck font.
                resolved=null;
                if (System.Text.RegularExpressions.Regex.IsMatch(requested, "Mincho|明朝|Serif|セリフ|Times|Georgia|Garamond", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                    foreach (string serif in new[] { "Yu Mincho", "BIZ UDPMincho", "MS PMincho" }) if (InstalledFonts.Contains(serif)) { resolved = serif; break; }
                if (resolved == null) resolved=InstalledFonts.Contains(fallback)?fallback:InstalledFonts.Contains("Yu Gothic")?"Yu Gothic":InstalledFonts.Contains("Meiryo")?"Meiryo":"Arial";
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

        private static dynamic AddShape(dynamic slide, Dictionary<string, object> e)
        {
            string kind = Text(e, "shape", "rect"), path = Text(e, "path", null);
            dynamic shape = path != null ? Freeform(slide, path) : slide.Shapes.AddShape(ShapeType(kind), Number(e, "x"), Number(e, "y"), Number(e, "w"), Number(e, "h"));
            string fill = Text(e, "fill", "#FFFFFF");
            if (fill == "none" || fill == "transparent") shape.Fill.Visible = 0;
            else
            {
                shape.Fill.Visible = -1; shape.Fill.Solid(); Paint(shape.Fill.ForeColor, Color(fill));
                if (e.ContainsKey("opacity")) shape.Fill.Transparency = (float)Math.Max(0, Math.Min(1, 1 - Number(e, "opacity", 1)));
            }
            // Corner radius of a rounded rectangle, as a share of the shorter side (0-0.5).
            if (kind == "roundRect" && e.ContainsKey("radius")) { try { shape.Adjustments[1] = (float)Math.Max(0, Math.Min(.5f, Number(e, "radius", .1f))); } catch { } }
            string stroke = Text(e, "stroke", "none");
            if (stroke == "none" || stroke == "transparent") shape.Line.Visible = 0;
            else
            {
                shape.Line.Visible = -1; Paint(shape.Line.ForeColor, Color(stroke)); shape.Line.Weight = Number(e, "strokeWidth", 1);
                if (Boolean(e, "dash")) shape.Line.DashStyle = 4;
                if (Boolean(e, "arrow")) shape.Line.EndArrowheadStyle = 2;
                if (Boolean(e, "arrowStart")) shape.Line.BeginArrowheadStyle = 2;
            }
            if (e.ContainsKey("rotation")) shape.Rotation = Number(e, "rotation");
            // A straight gradient (angle as in CSS: 0 upwards, 90 to the right; PowerPoint's 0 is to the right).
            object[] stops = ArrayOf(ObjectOf(e, "gradient"), "stops");
            if (fill != "none" && fill != "transparent" && stops.Length >= 2)
            {
                float opacity = Math.Max(0, Math.Min(1, Number(e, "opacity", 1)));
                shape.Fill.TwoColorGradient(1, 1);
                dynamic gradientStops = shape.Fill.GradientStops;
                int original = gradientStops.Count;
                foreach (object item in stops)
                {
                    var stop = AsObject(item);
                    gradientStops.Insert(Color(Text(stop, "color", fill)), Math.Max(0, Math.Min(1, Number(stop, "at", 0))), 1 - opacity * Math.Max(0, Math.Min(1, Number(stop, "op", 1))), gradientStops.Count + 1);
                }
                for (int k = 0; k < original; k++) gradientStops.Delete(1);
                Release((object)gradientStops);
                shape.Fill.GradientAngle = ((Number(ObjectOf(e, "gradient"), "angle", 180) - 90) % 360 + 360) % 360;
            }
            var shadow = ObjectOf(e, "shadow");
            if (shadow.Count > 0)
            {
                dynamic s = shape.Shadow;
                s.Visible = -1; s.OffsetX = Number(shadow, "x"); s.OffsetY = Number(shadow, "y"); s.Blur = Number(shadow, "blur");
                s.ForeColor.RGB = Color(Text(shadow, "color", "#000000")); s.Transparency = 1 - Math.Max(0, Math.Min(1, Number(shadow, "opacity", .25f)));
                Release((object)s);
            }
            return shape;
        }

        /// <summary>A freeform from one figure of M, L, C and Z commands in slide points.</summary>
        private static dynamic Freeform(dynamic slide, string path)
        {
            string[] t = path.Split(' ');
            Func<int, float> at = k => float.Parse(t[k], CultureInfo.InvariantCulture);
            if (t.Length < 3 || t[0] != "M") throw new InvalidDataException("図形の輪郭を読めません。");
            float x = at(1), y = at(2);
            dynamic builder = slide.Shapes.BuildFreeform(1, x, y);
            for (int i = 3; i < t.Length; )
            {
                string c = t[i++];
                if (c == "L") { builder.AddNodes(0, 1, at(i), at(i + 1)); i += 2; }
                else if (c == "C") { builder.AddNodes(1, 1, at(i), at(i + 1), at(i + 2), at(i + 3), at(i + 4), at(i + 5)); i += 6; }
                else if (c == "Z") builder.AddNodes(0, 1, x, y);
                else throw new InvalidDataException("図形の輪郭を読めません。");
            }
            dynamic shape = builder.ConvertToShape();
            Release((object)builder);
            return shape;
        }

        /// <summary>The one text of a box on an HTML page, written in the box's shape where the browser drew it (the
        /// margins inside the shape's text area, centred top to bottom when it was).</summary>
        private static void AddLabel(dynamic shape, Dictionary<string, object> e)
        {
            var place = ObjectOf(e, "inShape");
            object[] margin = ArrayOf(place, "margin");
            if (margin.Length != 4) margin = new object[] { 0, 0, 0, 0 };
            dynamic frame = shape.TextFrame2;
            frame.AutoSize = 0;
            frame.WordWrap = Boolean(e, "noWrap") ? 0 : -1;
            frame.MarginLeft = Convert.ToSingle(margin[0], CultureInfo.InvariantCulture); frame.MarginTop = Convert.ToSingle(margin[1], CultureInfo.InvariantCulture);
            frame.MarginRight = Convert.ToSingle(margin[2], CultureInfo.InvariantCulture); frame.MarginBottom = Convert.ToSingle(margin[3], CultureInfo.InvariantCulture);
            frame.VerticalAnchor = Boolean(place, "middle") ? 3 : 1;
            dynamic range = frame.TextRange;
            TextLook(range, e, Text(e, "font", FontName), Text(e, "fontFarEast", Text(e, "font", FontName)));
            Release((object)range); Release((object)frame);
        }

        /// <summary>Keeps the names of the shapes an element added (after the first `before`) under its group.</summary>
        private static void Collect(dynamic slide, Dictionary<string, List<string>> groups, string group, int before)
        {
            if (group == null) return;
            List<string> names;
            if (!groups.TryGetValue(group, out names)) groups[group] = names = new List<string>();
            for (int k = before + 1; k <= (int)slide.Shapes.Count; k++) { dynamic added = slide.Shapes(k); names.Add(Convert.ToString(added.Name)); Release((object)added); }
        }

        /// <summary>Groups the parts of each card of an HTML page, the innermost first (an icon's strokes are a group in
        /// its card). Parts PowerPoint cannot group stay as they are.</summary>
        private static void GroupShapes(dynamic slide, Dictionary<string, List<string>> groups)
        {
            var paths = new List<string>(groups.Keys);
            paths.Sort((a, b) => b.Split('/').Length - a.Split('/').Length);
            foreach (string path in paths)
            {
                List<string> names = groups[path];
                string name = names.Count == 1 ? names[0] : null;
                if (names.Count > 1)
                {
                    try
                    {
                        var list = new object[names.Count];
                        for (int k = 0; k < names.Count; k++) list[k] = names[k];
                        dynamic range = slide.Shapes.Range(list);
                        dynamic group = range.Group();
                        name = Convert.ToString(group.Name);
                        Release((object)group); Release((object)range);
                    }
                    catch { name = null; }
                }
                int cut = path.LastIndexOf('/');
                if (name == null || cut < 0) continue;
                List<string> parent;
                if (!groups.TryGetValue(path.Substring(0, cut), out parent)) continue;
                parent.Add(name);
            }
        }

        /// <summary>Inserts SVG artwork (or PNG data) as a picture. The file is written next to the output and removed.
        /// A photo of the app's image store is inserted from its file, cut to fill its box.</summary>
        private static void AddImage(dynamic slide, Dictionary<string, object> e, string output, int slideNumber)
        {
            string photo = Text(e, "file", null);
            if (photo != null)
            {
                if (!File.Exists(photo) || !System.Text.RegularExpressions.Regex.IsMatch(photo, @"\.(jpg|png)$")) return;
                // The cut is a share of the picture's own size (PowerPoint shrinks a large picture to the slide when
                // inserting it, but measures the cut on its own size), then the cut picture is set to the box.
                dynamic picture = slide.Shapes.AddPicture(photo, 0, -1, Number(e, "x"), Number(e, "y"), -1, -1);
                picture.ScaleHeight(1, -1); picture.ScaleWidth(1, -1);
                object[] crop = ArrayOf(e, "crop");
                if (crop.Length == 4)
                {
                    float w0 = (float)picture.Width, h0 = (float)picture.Height;
                    picture.PictureFormat.CropLeft = Convert.ToSingle(crop[0], CultureInfo.InvariantCulture) * w0;
                    picture.PictureFormat.CropTop = Convert.ToSingle(crop[1], CultureInfo.InvariantCulture) * h0;
                    picture.PictureFormat.CropRight = Convert.ToSingle(crop[2], CultureInfo.InvariantCulture) * w0;
                    picture.PictureFormat.CropBottom = Convert.ToSingle(crop[3], CultureInfo.InvariantCulture) * h0;
                }
                picture.LockAspectRatio = 0;
                picture.Left = Number(e, "x"); picture.Top = Number(e, "y"); picture.Width = Number(e, "w"); picture.Height = Number(e, "h");
                picture.AlternativeText = Text(e, "alt", "");
                Release((object)picture);
                return;
            }
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

        private static string AddLine(dynamic slide, Dictionary<string, object> e)
        {
            float y = Number(e,"y"), h = Number(e,"h");
            dynamic shape = slide.Shapes.AddLine(Number(e, "x"), y + (Boolean(e,"flipY") ? h : 0), Number(e, "x") + Number(e, "w"), y + (Boolean(e,"flipY") ? 0 : h));
            Paint(shape.Line.ForeColor, Color(Text(e, "stroke", "#D7DEE5")));
            shape.Line.Weight = Number(e, "strokeWidth", 1);
            if (Boolean(e, "arrow")) shape.Line.EndArrowheadStyle = 2;
            if (Boolean(e, "arrowStart")) shape.Line.BeginArrowheadStyle = 2;
            if (Boolean(e, "dash")) shape.Line.DashStyle = 4;
            string name = Convert.ToString(shape.Name);
            Release((object)shape);
            return name;
        }

        /// <summary>Glues a line's ends to the shapes the scene names (its nth shape and a connection site), so the
        /// line stays on them when they are moved. The scene already draws the ends on those sites.</summary>
        private static void Glue(dynamic slide, string name, Dictionary<string, object> e, List<string> boxes)
        {
            dynamic line = slide.Shapes(name), ends = line.ConnectorFormat;
            foreach (string end in new[] { "from", "to" })
            {
                var at = ObjectOf(e, end); int n = (int)Number(at, "shape", -1), site = (int)Number(at, "site", 0);
                if (n < 0 || n >= boxes.Count || site < 1) continue;
                dynamic box = slide.Shapes(boxes[n]);
                try { if (end == "from") ends.BeginConnect(box, site); else ends.EndConnect(box, site); } catch { }
                Release((object)box);
            }
            Release((object)ends); Release((object)line);
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
            shape.AlternativeText = Text(e, "alt", "");
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
                for (int row = 0; row < categories.Length; row++) values[row + 1, 0] = CellText(Convert.ToString(categories[row]));
                for (int col = 0; col < series.Length; col++)
                {
                    var s = AsObject(series[col]);
                    values[0, col + 1] = CellText(Text(s, "name", "系列 " + (col + 1)));
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
                // Excel reads labels that look like numbers or dates ("3", "2024") as one more series. Only for
                // such labels, bind each series to its name, values and the label column explicitly; the usual
                // path is left exactly as Excel built it.
                bool numberLikeLabels = false;
                foreach (object category in categories) if (CellText(Convert.ToString(category)) != Convert.ToString(category)) numberLikeLabels = true;
                if (numberLikeLabels)
                {
                    Stage = "スライド " + slideNumber + " のグラフ系列の指定";
                    string sheetRef = "='" + ((string)sheet.Name).Replace("'", "''") + "'!";
                    dynamic collection = chart.SeriesCollection();
                    // Drop only the series Excel made from the label column, then point the remaining
                    // series (each already bound to its name and values) at the label column.
                    while ((int)collection.Count > series.Length) collection.Item(1).Delete();
                    string last = (categories.Length + 1).ToString(CultureInfo.InvariantCulture);
                    for (int col = 1; col <= series.Length; col++) { dynamic existing = collection.Item(col); existing.XValues = sheetRef + "$A$2:$A$" + last; }
                }
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
                    // Highlighted categories (one colour per bar) are written into the chart XML by
                    // ChartIntegrity.Synchronize: here the live chart can still hold Excel's template points.
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
                        // A zero part of a stacked bar has nothing to label: the empty third (zero) section hides its "0".
                        string format = fractional ? "General" : "#,##0";
                        labels.NumberFormatLinked = false; labels.NumberFormat = share ? "0.0%" : stacked ? format + ";-" + format + ";" : format;
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
            string[] ids = requested == "cycle" ? new[] { "cycle1", "basicCycle" } : requested == "hierarchy" ? new[] { "hierarchy1", "orgChart1", "hierarchy" } : requested == "list" ? new[] { "default", "vList5" } : new[] { "process1", "basicProcess" };
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
            int accentColor = Color(Text(e, "accent", null), Accent);
            object[] fills = ArrayOf(e, "fills"), inks = ArrayOf(e, "inks");
            for (int i = 0; i < items.Length; i++)
            {
                dynamic node = nodes[i];
                var item = AsObject(items[i]);
                // The lead box (root, last step) keeps the full accent; supporting boxes step back to a tint.
                int nodeColor = i < fills.Length ? Color(Convert.ToString(fills[i]), accentColor) : accentColor;
                int inkColor = i < inks.Length ? Color(Convert.ToString(inks[i]), Color(Text(e, "color", "#FFFFFF"))) : Color(Text(e, "color", "#FFFFFF"));
                string description = Text(item, "description", "");
                node.TextFrame2.TextRange.Text = Text(item, "label", "") + (description.Length > 0 ? "\r" + description : "");
                node.TextFrame2.TextRange.Font.Name = FontName;
                node.TextFrame2.TextRange.Font.NameFarEast = FontName;
                node.TextFrame2.TextRange.Font.Size = Number(e, "fontSize", 18);
                node.TextFrame2.TextRange.Font.Fill.ForeColor.RGB = inkColor;
                // The label is the heading of its box; the description below it is quieter (sized after fitting).
                try { node.TextFrame2.TextRange.Paragraphs(1).Font.Bold = -1; } catch { }
                for (int s = 1; s <= (int)node.Shapes.Count; s++)
                {
                    dynamic nodeShape = node.Shapes.Item(s);
                    // SmartArt keeps its style's dark outline even after Line.Visible = 0, so the outline
                    // also takes the fill colour: hidden where Office honours the switch, invisible where not.
                    try { nodeShape.Fill.Solid(); nodeShape.Fill.ForeColor.RGB = nodeColor; } catch { }
                    try { nodeShape.Line.ForeColor.RGB = nodeColor; } catch { }
                    try { nodeShape.Line.Visible = 0; } catch { }
                    Release((object)nodeShape);
                }
            }
            // Check after all nodes are populated because SmartArt reflows as nodes are added.
            var fitted = new List<object>();
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
                FitSmartArtNode(node,width,height,Number(e,"fontSize",18),slideNumber);
                fitted.Add(itemNode);
            }
            MatchNodeSizes(fitted);
            foreach (object itemNode in fitted) Release(itemNode);
            Release((object)art); Release((object)shape); Release((object)layout);
        }

        /// <summary>The boxes of one diagram share their type sizes: every label and every description takes the
        /// smallest size any box needed, so one long note does not leave its box in smaller type than its row.</summary>
        private static void MatchNodeSizes(List<object> nodes)
        {
            float label = float.MaxValue, note = float.MaxValue;
            foreach (object item in nodes)
            {
                try
                {
                    dynamic range = ((dynamic)item).TextFrame2.TextRange;
                    int count = (int)range.Paragraphs().Count;
                    float size = (float)range.Paragraphs(1).Font.Size;
                    if (size > 0 && size < 200) label = Math.Min(label, size);
                    for (int p = 2; p <= count; p++)
                    {
                        size = (float)range.Paragraphs(p).Font.Size;
                        if (size > 0 && size < 200) note = Math.Min(note, size);
                    }
                    Release((object)range);
                }
                catch { }
            }
            foreach (object item in nodes)
            {
                try
                {
                    dynamic range = ((dynamic)item).TextFrame2.TextRange;
                    int count = (int)range.Paragraphs().Count;
                    if (label < float.MaxValue) range.Paragraphs(1).Font.Size = label;
                    if (note < float.MaxValue) for (int p = 2; p <= count; p++) range.Paragraphs(p).Font.Size = note;
                    Release((object)range);
                }
                catch { }
            }
        }

        /// <summary>Fits a SmartArt node: the label first, its description a size smaller (at least 10pt). Fonts with
        /// tall lines (Meiryo) can still overflow a small box; then the description is left out with a warning
        /// instead of failing the whole deck, and only a label that cannot fit at 12pt stops the export.</summary>
        private static void FitSmartArtNode(dynamic node, float width, float height, float requested, int slideNumber)
        {
            dynamic frame = node.TextFrame2;
            dynamic range = frame.TextRange;
            float availableWidth = width - (float)frame.MarginLeft - (float)frame.MarginRight;
            float availableHeight = height - (float)frame.MarginTop - (float)frame.MarginBottom;
            float minimum = Math.Min(requested, 12f);
            float size = requested;
            SizeNodeText(range, size);
            while (NodeOverflows(range, availableWidth, availableHeight) && size > minimum) { size = Math.Max(minimum, size - 1); SizeNodeText(range, size); }
            int paragraphs = 1;
            try { paragraphs = (int)range.Paragraphs().Count; } catch { }
            if (NodeOverflows(range, availableWidth, availableHeight) && paragraphs > 1)
            {
                string label = Convert.ToString(range.Paragraphs(1).Text).TrimEnd('\r', '\n', '\v');
                range.Text = label;
                try { range.Font.Bold = -1; } catch { }
                Warnings.Add("スライド " + slideNumber + ": 図の「" + Short(label) + "」の説明が箱に収まらないため省きました。詳しい説明は発表者ノートに書いてください。");
                size = requested; SizeNodeText(range, size);
                while (NodeOverflows(range, availableWidth, availableHeight) && size > minimum) { size = Math.Max(minimum, size - 1); SizeNodeText(range, size); }
            }
            if (NodeOverflows(range, availableWidth, availableHeight))
                throw new InvalidDataException("TEXT_FIT_REQUIRED: スライド " + slideNumber + " の図の項目名が箱に収まりません。項目名を短くしてください（" + Short(Convert.ToString(range.Text)) + "）。");
            AvoidOrphans(range);
            Release((object)range); Release((object)frame);
        }
        /// <summary>A description that wraps with only one or two characters on its second line reads as a mistake
        /// (毎日 / 記録): it is set a point smaller at a time, down to 11pt, until it keeps to one line.</summary>
        private static void AvoidOrphans(dynamic range)
        {
            try
            {
                int count = (int)range.Paragraphs().Count;
                for (int p = 2; p <= count; p++)
                {
                    dynamic paragraph = range.Paragraphs(p);
                    float size = (float)paragraph.Font.Size;
                    while ((int)paragraph.Lines().Count == 2 && Convert.ToString(paragraph.Lines(2).Text).Trim().Length <= 2 && size > 11)
                    {
                        size -= 1; paragraph.Font.Size = size;
                    }
                    Release((object)paragraph);
                }
            }
            catch { }
        }
        private static bool NodeOverflows(dynamic range, float width, float height)
        {
            return (float)range.BoundHeight > height + 1 || (float)range.BoundWidth > width + 1;
        }
        /// <summary>The label at size, any description paragraphs 4pt smaller (at least 10pt).</summary>
        private static void SizeNodeText(dynamic range, float size)
        {
            range.Font.Size = size;
            try
            {
                int count = (int)range.Paragraphs().Count;
                for (int p = 2; p <= count; p++) range.Paragraphs(p).Font.Size = Math.Max(10f, size - 4);
            }
            catch { }
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

        private static int LabelInk(int officeColor) {
            // Office stores RGB in BGR order; choose white/dark by relative luminance.
            double[] channels = { (officeColor & 255) / 255.0, ((officeColor >> 8) & 255) / 255.0, ((officeColor >> 16) & 255) / 255.0 };
            for (int i = 0; i < 3; i++) channels[i] = channels[i] <= .04045 ? channels[i]/12.92 : Math.Pow((channels[i]+.055)/1.055,2.4);
            double light = .2126*channels[0]+.7152*channels[1]+.0722*channels[2];
            return light < .179 ? Color("#FFFFFF") : Color("#172D4A");
        }
        private struct Box { public float L, T, R, B; }
        // The helpers take object, not dynamic, so calls to them (and the lambdas passed to them) bind at compile time.
        private static Box ShapeBox(object item)
        {
            dynamic shape = item;
            var box = new Box();
            box.L = (float)shape.Left; box.T = (float)shape.Top;
            box.R = box.L + (float)shape.Width; box.B = box.T + (float)shape.Height;
            return box;
        }
        private static float TextSize(object item)
        {
            dynamic shape = item;
            try { float size = (float)shape.TextFrame2.TextRange.Font.Size; if (size > 0 && size < 400) return size; } catch { }
            return 18;
        }
        /// <summary>Where the characters of each line of a shape's text are. A line's box holds the leading above and
        /// below its characters, so a sixth of it is taken off the top and an eighth off the bottom; BoundWidth runs up
        /// to a quarter of the size past the last character, so that much is taken off the right.</summary>
        private static List<Box> LineBoxes(object item)
        {
            dynamic shape = item;
            dynamic range = shape.TextFrame2.TextRange;
            var boxes = new List<Box>();
            int lines = 0;
            try { lines = (int)range.Lines().Count; } catch { }
            for (int i = 1; i <= lines; i++)
            {
                dynamic line = range.Lines(i);
                float size = 18;
                try { float s = (float)line.Font.Size; if (s > 0 && s < 400) size = s; } catch { }
                var box = new Box();
                box.L = (float)line.BoundLeft; box.T = (float)line.BoundTop;
                box.R = box.L + (float)line.BoundWidth - 0.25f * size; box.B = box.T + (float)line.BoundHeight;
                float height = box.B - box.T;
                box.T += height / 6; box.B -= height / 8;
                if (box.R > box.L + 1 && box.B > box.T) boxes.Add(box);
                Release((object)line);
            }
            Release((object)range);
            return boxes;
        }
        /// <summary>Where the characters of a shape's text are: the lines' boxes together.</summary>
        private static Box InkBox(object item)
        {
            List<Box> lines = LineBoxes(item);
            if (lines.Count == 0) return ShapeBox(item);
            Box ink = lines[0];
            foreach (Box line in lines) { ink.L = Math.Min(ink.L, line.L); ink.T = Math.Min(ink.T, line.T); ink.R = Math.Max(ink.R, line.R); ink.B = Math.Max(ink.B, line.B); }
            return ink;
        }
        private static float Overlap(float a1, float a2, float b1, float b2) { return Math.Min(a2, b2) - Math.Max(a1, b1); }
        private static string TextOf(object item)
        {
            dynamic shape = item;
            try
            {
                string text = Convert.ToString(shape.TextFrame2.TextRange.Text);
                return Short(text.Replace("\r", " ").Replace("\n", " ").Replace("\v", " ").Trim());
            }
            catch { return ""; }
        }
        /// <summary>Whether a text's characters stay in its own box: a few points of slack, a third of a line below.</summary>
        private static bool StaysInBox(object item)
        {
            Box box = ShapeBox(item), ink = InkBox(item);
            float across = Math.Max(3f, 0.06f * (box.R - box.L)), down = Math.Max(3f, 0.3f * TextSize(item));
            return ink.L >= box.L - across && ink.R <= box.R + across && ink.T >= box.T - down && ink.B <= box.B + down;
        }
        /// <summary>Sets a text up to 10% smaller (2% at a time, not below 9pt; steps sets how far) until ok holds. Left
        /// as it was when that is not enough, so a page is not made smaller for nothing.</summary>
        private static bool ShrinkUntil(object item, Func<bool> ok, int steps = 5)
        {
            dynamic shape = item;
            dynamic range = shape.TextFrame2.TextRange;
            var sizes = new List<float>();
            int runs = 0;
            try { runs = (int)range.Runs().Count; for (int r = 1; r <= runs; r++) sizes.Add((float)range.Runs(r).Font.Size); } catch { runs = 0; }
            if (runs == 0 || sizes.Exists(v => !(v > 0 && v < 400))) { Release((object)range); return false; }
            bool done = false;
            for (int step = 1; step <= steps && !done; step++)
            {
                for (int r = 1; r <= runs; r++) range.Runs(r).Font.Size = Math.Max(9f, sizes[r - 1] * (1 - 0.02f * step));
                done = ok();
            }
            if (!done) for (int r = 1; r <= runs; r++) range.Runs(r).Font.Size = sizes[r - 1];
            Release((object)range);
            return done;
        }
        private static void Issue(int slideNumber, string kind, string text, string other)
        {
            var issue = new Dictionary<string, object>();
            issue["slide"] = slideNumber; issue["kind"] = kind; issue["text"] = text;
            if (other != null) issue["other"] = other;
            Issues.Add(issue);
        }
        /// <summary>Whether a line runs into the cut-in (chevron) or point (chevron, pentagon) of a shape, taken at the
        /// heights the line covers: the cut-in is deepest at the middle, the point narrows towards the top and bottom.</summary>
        private static bool HitsPoint(Box line, Box box, float depth, bool chevron)
        {
            float middle = (box.T + box.B) / 2, half = (box.B - box.T) / 2;
            if (half <= 0) return false;
            float nearest = Math.Max(line.T, Math.Min(middle, line.B)), farthest = Math.Abs(line.T - middle) > Math.Abs(line.B - middle) ? line.T : line.B;
            float cutIn = box.L + depth * (1 - Math.Min(1, Math.Abs(nearest - middle) / half));
            float tip = box.R - depth * Math.Min(1, Math.Abs(farthest - middle) / half);
            // A few points of room, not a touch: a character at the very tip of the cut-in reads as cut off.
            return (chevron && line.L < cutIn + 4) || line.R > tip - 4;
        }
        private static bool Inside(Box ink, Box box, float margin)
        {
            return ink.L >= box.L + margin && ink.T >= box.T + margin && ink.R <= box.R - margin && ink.B <= box.B - margin;
        }
        private static float Share(Box ink, Box box)
        {
            float wide = Overlap(ink.L, ink.R, box.L, box.R), tall = Overlap(ink.T, ink.B, box.T, box.B), area = (ink.R - ink.L) * (ink.B - ink.T);
            return wide <= 0 || tall <= 0 || area <= 0 ? 0 : wide * tall / area;
        }
        /// <summary>Text as PowerPoint set it, checked once the slide's parts are placed: text past its own box, two
        /// texts over each other, text past the edge of the card under it, a table grown over the part below it, and
        /// text running into the cut-in or point of a chevron or pentagon (its own label too). A text a little too large
        /// is set up to 10% smaller first; what remains is listed (Issues) for the app to show once the deck is made.</summary>
        private static void CheckTextLayout(dynamic slide, int slideNumber)
        {
            var texts = new List<object>(); var cards = new List<object>(); var points = new List<object>(); var tables = new List<object>(); var held = new List<object>();
            var depthOf = new Dictionary<object, int>();
            int count = (int)slide.Shapes.Count;
            for (int k = 1; k <= count; k++)
            {
                object item = slide.Shapes.Item(k);
                dynamic shape = item;
                held.Add(item);
                depthOf[item] = k; // Shapes are listed back to front.
                int type = 0, auto = 0;
                try { type = (int)shape.Type; } catch { }
                try { if (type == 1) auto = (int)shape.AutoShapeType; } catch { }
                bool text = false, filled = false, table = false;
                try { text = (type == 1 || type == 14 || type == 17) && (int)shape.HasTextFrame != 0 && (int)shape.TextFrame2.HasText != 0; } catch { }
                try { filled = type == 1 && (int)shape.Fill.Visible != 0; } catch { }
                try { table = (int)shape.HasTable != 0; } catch { }
                if (text) texts.Add(item);
                if (filled) cards.Add(item);
                if (table) tables.Add(item);
                if (auto == 52 || auto == 51) points.Add(item); // chevron, pentagon (home plate)
            }
            try
            {
                foreach (object item in texts)
                {
                    object current = item;
                    if (!StaysInBox(current) && !ShrinkUntil(current, () => StaysInBox(current)))
                        Issue(slideNumber, "overflow", TextOf(current), null);
                }
                for (int a = 0; a < texts.Count; a++)
                    for (int b = a + 1; b < texts.Count; b++)
                    {
                        object first = texts[a], second = texts[b];
                        Func<bool> apart = () =>
                        {
                            Box x = InkBox(first), y = InkBox(second);
                            return Overlap(x.L, x.R, y.L, y.R) <= 3 || Overlap(x.T, x.B, y.T, y.B) <= 3;
                        };
                        // Two texts over each other read worse than one a little smaller than its neighbours: up to 20%.
                        if (apart() || ShrinkUntil(second, apart, 10) || ShrinkUntil(first, apart, 10)) continue;
                        Issue(slideNumber, "overlap", TextOf(first), TextOf(second));
                    }
                // A text set on a card (most of it over a filled shape behind it) keeps 2pt inside the card's edges.
                var onCard = new Dictionary<object, List<object>>(); var flagged = new List<object>();
                foreach (object item in texts)
                {
                    object current = item, card = null;
                    Box ink = InkBox(current);
                    foreach (object candidate in cards)
                        if (!ReferenceEquals(candidate, current) && depthOf[candidate] < depthOf[current] && Share(ink, ShapeBox(candidate)) >= 0.6f
                            && (card == null || depthOf[candidate] > depthOf[card])) card = candidate;
                    if (card == null) continue;
                    if (!onCard.ContainsKey(card)) onCard[card] = new List<object>();
                    onCard[card].Add(current);
                    if (Inside(ink, ShapeBox(card), 2)) continue;
                    object under = card;
                    if (ShrinkUntil(current, () => Inside(InkBox(current), ShapeBox(under), 2))) continue;
                    Issue(slideNumber, "edge", TextOf(current), null);
                    flagged.Add(current);
                }
                // The card's room below its last text is not squeezed: under 8pt while the room above is 2.5 times that.
                foreach (var pair in onCard)
                {
                    Box card = ShapeBox(pair.Key);
                    float above = float.MaxValue, below = float.MaxValue;
                    object lowest = null;
                    foreach (object text in pair.Value)
                    {
                        Box ink = InkBox(text);
                        above = Math.Min(above, ink.T - card.T);
                        if (card.B - ink.B < below) { below = card.B - ink.B; lowest = text; }
                    }
                    if (lowest == null || flagged.Contains(lowest) || below >= 8 || above < 2.5f * Math.Max(below, 1)) continue;
                    object last = lowest;
                    float wanted = Math.Min(8f, above / 2.5f);
                    if (ShrinkUntil(last, () => card.B - InkBox(last).B >= wanted)) continue;
                    Issue(slideNumber, "edge", TextOf(last), null);
                }
                // A table PowerPoint made taller (its rows grow to their text) must not run over the parts around it.
                foreach (object item in tables)
                {
                    Box grid = ShapeBox(item);
                    foreach (object other in Union(texts, cards))
                    {
                        Box box = texts.Contains(other) ? InkBox(other) : ShapeBox(other);
                        // A panel behind the table, or a note set on it, belongs with it.
                        if (Share(grid, ShapeBox(other)) >= 0.9f || Share(box, grid) >= 0.9f) continue;
                        if (Overlap(grid.L, grid.R, box.L, box.R) <= 1 || Overlap(grid.T, grid.B, box.T, box.B) <= 1) continue;
                        object table = item;
                        // Smaller type lets the rows go back to the heights they were given.
                        if (ShrinkTable(table, () => { Box g = ShapeBox(table); return Overlap(g.L, g.R, box.L, box.R) <= 1 || Overlap(g.T, g.B, box.T, box.B) <= 1; })) continue;
                        Issue(slideNumber, "overlap", "表", texts.Contains(other) ? TextOf(other) : "囲み");
                        break;
                    }
                }
                foreach (object item in points)
                {
                    dynamic point = item;
                    Box box = ShapeBox(item);
                    float adjust = 0.5f;
                    try { adjust = (float)point.Adjustments.Item(1); } catch { }
                    float depth = adjust * Math.Min(box.R - box.L, box.B - box.T);
                    bool chevron = (int)point.AutoShapeType == 52;
                    foreach (object other in texts)
                    {
                        // Only a text set on this shape (its own label, or most of a text over it).
                        if (!ReferenceEquals(other, item) && Share(InkBox(other), box) < 0.5f) continue;
                        object current = other;
                        Func<bool> clear = () => !LineBoxes(current).Exists(line => HitsPoint(line, box, depth, chevron));
                        if (clear() || ShrinkUntil(current, clear)) continue;
                        Issue(slideNumber, "notch", TextOf(current), null);
                    }
                }
            }
            catch (Exception ex) { Warnings.Add("スライド " + slideNumber + ": 文字の重なりを確かめられませんでした（" + Short(ex.Message) + "）。"); }
            foreach (object shape in held) Release(shape);
        }
        /// <summary>Sets every cell of a table up to 20% smaller (2% at a time, not below 9pt) until ok holds; left as it
        /// was when that is not enough.</summary>
        private static bool ShrinkTable(object item, Func<bool> ok, int steps = 10)
        {
            dynamic shape = item;
            dynamic table = shape.Table;
            int rows = (int)table.Rows.Count, columns = (int)table.Columns.Count;
            var sizes = new float[rows, columns];
            for (int r = 1; r <= rows; r++)
                for (int c = 1; c <= columns; c++)
                {
                    float size = 0;
                    try { size = (float)table.Cell(r, c).Shape.TextFrame2.TextRange.Font.Size; } catch { }
                    sizes[r - 1, c - 1] = size > 0 && size < 400 ? size : 0;
                }
            bool done = false;
            for (int step = 1; step <= steps && !done; step++)
            {
                for (int r = 1; r <= rows; r++)
                    for (int c = 1; c <= columns; c++)
                        if (sizes[r - 1, c - 1] > 0) table.Cell(r, c).Shape.TextFrame2.TextRange.Font.Size = Math.Max(9f, sizes[r - 1, c - 1] * (1 - 0.02f * step));
                done = ok();
            }
            if (!done)
                for (int r = 1; r <= rows; r++)
                    for (int c = 1; c <= columns; c++)
                        if (sizes[r - 1, c - 1] > 0) table.Cell(r, c).Shape.TextFrame2.TextRange.Font.Size = sizes[r - 1, c - 1];
            Release((object)table);
            return done;
        }
        private static List<object> Union(List<object> a, List<object> b)
        {
            var all = new List<object>(a);
            foreach (object item in b) if (!all.Contains(item)) all.Add(item);
            return all;
        }
        private static string Short(string text) { return text.Length > 28 ? text.Substring(0, 28) + "…" : text; }
        private static Dictionary<string, object> AsObject(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
        private static Dictionary<string, object> ObjectOf(Dictionary<string, object> d, string key) { object v; return d.TryGetValue(key, out v) ? AsObject(v) : new Dictionary<string, object>(); }
        /// <summary>A chart label or series name as a text cell. Formula-like text, and text that Excel
        /// would turn into a number or date ("3", "2024", "1/2"), gets Excel's text marker (a leading
        /// apostrophe, which is not part of the value).</summary>
        private static string CellText(string text)
        {
            if (text.Length > 0 && ("=+-@\t\r".IndexOf(text[0]) >= 0 || System.Text.RegularExpressions.Regex.IsMatch(text, @"^\s*[+\-−]?[\d,.]+\s*%?\s*$|^\s*\d{1,4}\s*[/\-.]\s*\d{1,2}(\s*[/\-.]\s*\d{1,4})?\s*$"))) return "'" + text;
            return text;
        }
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
