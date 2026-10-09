using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Windows.Forms;

[assembly: ComVisible(false)]
[assembly: AssemblyVersion("0.1.0.0")]
[assembly: AssemblyTitle("Designer Extention PowerPoint Add-in")]

namespace DesignerExtension.Native
{
    // Match the Office PIA ABI, especially SAFEARRAY(VARIANT)*. A plain ref Array
    // marshals differently and can corrupt the native caller during startup.
    [ComImport, Guid("B65AD801-ABAF-11D0-BB8B-00A0C90F2744"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IDTExtensibility2
    {
        [DispId(1)] void OnConnection([In, MarshalAs(UnmanagedType.IDispatch)] object application, [In] int connectMode, [In, MarshalAs(UnmanagedType.IDispatch)] object addInInst, [In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType=VarEnum.VT_VARIANT)] ref Array custom);
        [DispId(2)] void OnDisconnection([In] int removeMode, [In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType=VarEnum.VT_VARIANT)] ref Array custom);
        [DispId(3)] void OnAddInsUpdate([In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType=VarEnum.VT_VARIANT)] ref Array custom);
        [DispId(4)] void OnStartupComplete([In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType=VarEnum.VT_VARIANT)] ref Array custom);
        [DispId(5)] void OnBeginShutdown([In, MarshalAs(UnmanagedType.SafeArray, SafeArraySubType=VarEnum.VT_VARIANT)] ref Array custom);
    }
    [ComImport, Guid("000C0396-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsDual)]
    public interface IRibbonExtensibility
    {
        [DispId(1)] [return: MarshalAs(UnmanagedType.BStr)] string GetCustomUI([MarshalAs(UnmanagedType.BStr)] string ribbonID);
    }

    [ComVisible(true), Guid("EA8E8197-C2D4-4530-985C-F62677DAF6AC"), ProgId("DesignerExtension.Connect"), ClassInterface(ClassInterfaceType.AutoDispatch)]
    public class Connect : IDTExtensibility2, IRibbonExtensibility
    {
        public void OnConnection(object application, int connectMode, object addInInst, ref Array custom) { }
        public void OnDisconnection(int removeMode, ref Array custom) { }
        public void OnAddInsUpdate(ref Array custom) { }
        // The task pane page is served by the local app. Starting it with
        // PowerPoint means the pane does not show "connection refused" when the
        // user forgot Start-DesignerExtension.cmd. The launcher is idempotent.
        public void OnStartupComplete(ref Array custom)
        {
            try { StartLocalApp(false); } catch { /* Startup must never block PowerPoint. */ }
        }
        public void OnBeginShutdown(ref Array custom) { }
        public string GetCustomUI(string ribbonID)
        {
            return "<customUI xmlns=\"http://schemas.microsoft.com/office/2009/07/customui\"><ribbon><tabs><tab id=\"DesignerExtensionTab\" label=\"Designer Extention\"><group id=\"DesignerExtensionGroup\" label=\"スライドを作成\"><button id=\"DesignerExtensionOpen\" label=\"作成画面を開く\" size=\"large\" imageMso=\"SlideNew\" onAction=\"OpenDesigner\" screentip=\"Designer Extention\" supertip=\"ローカルの作成画面で資料と指示を入力します。\"/></group></tab></tabs></ribbon></customUI>";
        }
        public void OpenDesigner([MarshalAs(UnmanagedType.IDispatch)] object control)
        {
            try { StartLocalApp(true); }
            catch (Exception ex) { MessageBox.Show(ex.Message, "Designer Extention", MessageBoxButtons.OK, MessageBoxIcon.Error); }
        }
        static void StartLocalApp(bool openBrowser)
        {
            string nativeDirectory = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
            // The DLL resides in native/bin. Resolve only our known launcher.
            string projectDirectory = Path.GetFullPath(Path.Combine(nativeDirectory, "..", ".."));
            string launcher = Path.Combine(projectDirectory, "Start-DesignerExtension.ps1");
            if (!File.Exists(launcher)) throw new FileNotFoundException("起動ファイルが見つかりません。アドインを再インストールしてください。", launcher);
            var start = new ProcessStartInfo("powershell.exe", "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + launcher + "\"" + (openBrowser ? "" : " -NoOpen"));
            start.WorkingDirectory = projectDirectory;
            start.UseShellExecute = false;
            start.CreateNoWindow = true;
            start.WindowStyle = ProcessWindowStyle.Hidden;
            Process.Start(start);
        }
    }
}
