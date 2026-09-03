# Mute Dolphin while it is hidden.
#
# Melee makes noise the whole time it is booting and walking through the menus,
# and the app's cover hides the picture but not the sound. Dolphin's own volume
# only applies at startup, so muting has to happen at the Windows level: each
# process gets an audio session, and that session can be muted independently.
#
# Long-lived on purpose: Add-Type compiles on first use and that is far too slow
# to do at the moment sound needs to stop. Commands arrive on stdin:
#   mute <pid> | unmute <pid> | quit
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumerator { }

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  int NotImpl1();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams,
    [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionManager2 {
  int NotImpl1();
  int NotImpl2();
  int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionEnumerator {
  int GetCount(out int SessionCount);
  int GetSession(int SessionCount, out IAudioSessionControl2 Session);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioSessionControl2 {
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

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface ISimpleAudioVolume {
  int SetMasterVolume(float fLevel, ref Guid EventContext);
  int GetMasterVolume(out float pfLevel);
  int SetMute(bool bMute, ref Guid EventContext);
  int GetMute(out bool pbMute);
}

public static class SessionMute {
  public static bool Set(uint pid, bool mute) {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
    IMMDevice device;
    if (enumerator.GetDefaultAudioEndpoint(0, 1, out device) != 0) return false;   // eRender, eMultimedia
    var iid = typeof(IAudioSessionManager2).GUID;
    object o;
    if (device.Activate(ref iid, 1, IntPtr.Zero, out o) != 0) return false;
    var mgr = (IAudioSessionManager2)o;
    IAudioSessionEnumerator sessions;
    if (mgr.GetSessionEnumerator(out sessions) != 0) return false;
    int count;
    sessions.GetCount(out count);
    var ctx = Guid.Empty;
    bool hit = false;
    for (int i = 0; i < count; i++) {
      IAudioSessionControl2 ctl;
      if (sessions.GetSession(i, out ctl) != 0) continue;
      uint spid;
      if (ctl.GetProcessId(out spid) != 0) continue;
      if (spid != pid) continue;
      var vol = ctl as ISimpleAudioVolume;
      if (vol == null) continue;
      if (vol.SetMute(mute, ref ctx) == 0) hit = true;
    }
    return hit;
  }
}
'@

Write-Output "ready"
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $parts = $line.Trim() -split '\s+'
  if ($parts[0] -eq 'quit') { break }
  if ($parts.Count -lt 2) { continue }
  $mute = $parts[0] -eq 'mute'
  $procId = 0
  if (-not [uint32]::TryParse($parts[1], [ref]$procId)) { continue }
  # The session does not exist until the process has actually produced sound,
  # so keep trying briefly rather than giving up on the first miss.
  $done = $false
  for ($i = 0; $i -lt 40 -and -not $done; $i++) {
    try { $done = [SessionMute]::Set($procId, $mute) } catch { $done = $false }
    if (-not $done) { Start-Sleep -Milliseconds 100 }
  }
  Write-Output "$($parts[0]) $procId $(if ($done) { 'ok' } else { 'no-session' })"
}
