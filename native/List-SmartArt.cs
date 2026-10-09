using System;
using System.Runtime.InteropServices;
using System.Text;

// Read-only diagnostic for matching installed Office SmartArt layout IDs.
internal static class ListSmartArt
{
    [STAThread]
    private static int Main()
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        object app = null, layouts = null;
        try
        {
            app = Marshal.GetActiveObject("PowerPoint.Application");
            layouts = ((dynamic)app).SmartArtLayouts;
            for (int i = 1; i <= (int)((dynamic)layouts).Count; i++)
            {
                object layout = ((dynamic)layouts).Item(i);
                try { Console.WriteLine(((dynamic)layout).Id + "\t" + ((dynamic)layout).Name); }
                finally { Marshal.ReleaseComObject(layout); }
            }
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
        finally
        {
            if (layouts != null) Marshal.ReleaseComObject(layouts);
            if (app != null) Marshal.ReleaseComObject(app);
        }
    }
}
