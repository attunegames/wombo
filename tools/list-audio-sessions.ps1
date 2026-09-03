# Who owns the audio sessions right now, and on which endpoint? Used to work out
# why muting Dolphin by its process id found nothing.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] public class MMDeviceEnumeratorL { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumeratorL {
  int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IMMDeviceCollectionL ppDevices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDeviceL ppEndpoint);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollectionL {
  int GetCount(out int pcDevices);
  int Item(int nDevice, out IMMDeviceL ppDevice);
}
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceL {
  int Activate(ref Guid iid, int dwClsCtx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  int OpenPropertyStore(int access, out IntPtr ppProperties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
}
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2L {
  int NotImpl1(); int NotImpl2();
  int GetSessionEnumerator(out IAudioSessionEnumeratorL SessionEnum);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumeratorL {
  int GetCount(out int SessionCount);
  int GetSession(int SessionCount, out IAudioSessionControl2L Session);
}
[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2L {
  // IAudioSessionControl has NINE methods after IUnknown, and
  // IAudioSessionControl2 adds GetSessionIdentifier and
  // GetSessionInstanceIdentifier before GetProcessId - so ELEVEN
  // placeholders. With ten, GetProcessId lands on the wrong vtable slot
  // and returns a pointer reinterpreted as a pid (seen: 1227665744).
  int NotImpl0(); int NotImpl1(); int NotImpl2(); int NotImpl3(); int NotImpl4();
  int NotImpl5(); int NotImpl6(); int NotImpl7(); int NotImpl8(); int NotImpl9();
  int NotImpl10();
  int GetProcessId(out uint pRetVal);
}

public static class SessionList {
  public static List<string> All() {
    var res = new List<string>();
    var en = (IMMDeviceEnumeratorL)(new MMDeviceEnumeratorL());
    IMMDeviceCollectionL col;
    if (en.EnumAudioEndpoints(0, 1, out col) != 0) return res;   // eRender, DEVICE_STATE_ACTIVE
    int devs; col.GetCount(out devs);
    for (int d = 0; d < devs; d++) {
      IMMDeviceL dev;
      if (col.Item(d, out dev) != 0) continue;
      string id; dev.GetId(out id);
      var iid = typeof(IAudioSessionManager2L).GUID;
      object o;
      if (dev.Activate(ref iid, 1, IntPtr.Zero, out o) != 0) continue;
      IAudioSessionEnumeratorL se;
      if (((IAudioSessionManager2L)o).GetSessionEnumerator(out se) != 0) continue;
      int n; se.GetCount(out n);
      for (int i = 0; i < n; i++) {
        IAudioSessionControl2L c;
        if (se.GetSession(i, out c) != 0) continue;
        uint pid;
        if (c.GetProcessId(out pid) != 0) continue;
        res.Add(pid + "|" + id);
      }
    }
    return res;
  }
}
'@

foreach ($row in [SessionList]::All()) {
  $parts = $row -split '\|', 2
  $name = try { (Get-Process -Id ([int]$parts[0]) -ErrorAction Stop).ProcessName } catch { "(gone)" }
  Write-Output "session pid=$($parts[0]) name=$name device=$($parts[1].Substring([Math]::Max(0,$parts[1].Length-24)))"
}
Write-Output "--- dolphin ---"
Get-Process | Where-Object { $_.ProcessName -like '*Dolphin*' } | ForEach-Object { Write-Output "dolphin pid=$($_.Id)" }
