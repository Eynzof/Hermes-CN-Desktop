param([string]$Root='C:\HermesE2E')
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms,System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class NativeE2EWindow {
  [DllImport("advapi32.dll", EntryPoint="CredDeleteW", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool CredDelete(string target, uint type, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out Rect bounds);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
  [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu, int position);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
  [DllImport("user32.dll")] static extern bool GetMenuItemRect(IntPtr hwnd, IntPtr menu, uint position, out Rect bounds);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr menu, uint item, StringBuilder text, int count, uint flags);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int command);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint msg, IntPtr wparam, string lparam);
  public class Control { public long handle; public int id; public uint pid; public string text; public string type; public int left,top,right,bottom; }
  public static Control[] MenuItems(IntPtr hwnd) {
    IntPtr menu = SendMessage(hwnd, 0x1E1, IntPtr.Zero, IntPtr.Zero);
    var result = new List<Control>();
    for (int index=0; index<GetMenuItemCount(menu); index++) {
      var text = new StringBuilder(512);
      GetMenuString(menu, (uint)index, text, text.Capacity, 0x400);
      Rect bounds;
      GetMenuItemRect(IntPtr.Zero, menu, (uint)index, out bounds);
      result.Add(new Control { id=(int)GetMenuItemID(menu,index), text=text.ToString(), type="MenuItem", left=bounds.left,top=bounds.top,right=bounds.right,bottom=bounds.bottom });
    }
    return result.ToArray();
  }
  public static Control[] Windows() {
    var result = new List<Control>();
    EnumWindows((hwnd, param) => {
      if (!IsWindowVisible(hwnd)) return true;
      var text = new StringBuilder(4096); var type = new StringBuilder(128);
      GetWindowText(hwnd, text, text.Capacity); GetClassName(hwnd, type, type.Capacity);
      uint processId; GetWindowThreadProcessId(hwnd, out processId);
      Rect bounds; GetWindowRect(hwnd, out bounds);
      result.Add(new Control { handle=hwnd.ToInt64(), pid=processId, text=text.ToString(), type=type.ToString(), left=bounds.left,top=bounds.top,right=bounds.right,bottom=bounds.bottom });
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
  public static Control[] Controls(IntPtr parent) {
    var result = new List<Control>();
    EnumChildWindows(parent, (hwnd, param) => {
      if (!IsWindowVisible(hwnd)) return true;
      var text = new StringBuilder(4096); var type = new StringBuilder(128);
      GetWindowText(hwnd, text, text.Capacity); GetClassName(hwnd, type, type.Capacity);
      result.Add(new Control { handle=hwnd.ToInt64(), id=GetDlgCtrlID(hwnd), text=text.ToString(), type=type.ToString() });
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$inbox=Join-Path $Root 'control\inbox'
$outbox=Join-Path $Root 'control\outbox'
New-Item $inbox,$outbox -ItemType Directory -Force | Out-Null
function DescribeElement($element) {
  $c=$element.Current
  return @{name=$c.Name;id=$c.AutomationId;type=$c.ControlType.ProgrammaticName;class=$c.ClassName;pid=$c.ProcessId;handle=$c.NativeWindowHandle;enabled=$c.IsEnabled;offscreen=$c.IsOffscreen;minimized=[NativeE2EWindow]::IsIconic([IntPtr]$c.NativeWindowHandle);maximized=[NativeE2EWindow]::IsZoomed([IntPtr]$c.NativeWindowHandle)}
}
while($true) {
  foreach($file in @(Get-ChildItem $inbox -Filter '*.json')) {
    $result=@{ok=$false}
    try {
      $request=Get-Content $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
      $processInfo=Get-Content (Join-Path $Root 'reports\desktop-process.json') -Raw | ConvertFrom-Json
      # Owned modal dialogs may be absent from UIA RootElement.Children.
      # Enumerate real HWNDs for this exact installed-app process first.
      $windows=@([NativeE2EWindow]::Windows() | Where-Object {$_.pid -eq [int]$processInfo.pid} | ForEach-Object {
        $handle=[IntPtr]$_.handle
        try {[System.Windows.Automation.AutomationElement]::FromHandle($handle)}
        catch {if([NativeE2EWindow]::IsWindow($handle)){throw}}
      })
      if($request.action -eq 'deleteUpdateFixtureCredential') {
        if([string]$request.deviceId -notmatch '^signed-update-\d+$'){throw 'Only an exact local test invitation credential may be removed'}
        $target=[string]$request.deviceId+'.cn.org.hermesagent.desktop.hot-update'
        $deleted=[NativeE2EWindow]::CredDelete($target,1,0)
        $code=if($deleted){0}else{[Runtime.InteropServices.Marshal]::GetLastWin32Error()}
        if($code -notin @(0,1168)){throw "Test credential removal failed: $code"}
        $result=@{ok=$true;target=$target;deleted=$deleted}
      } elseif($request.action -eq 'windows') {
        $result=@{ok=$true;windows=@($windows | ForEach-Object {DescribeElement $_})}
      } elseif($request.action -eq 'notificationCenter') {
        [NativeE2EWindow]::keybd_event(0x5B,0,0,[UIntPtr]::Zero)
        [NativeE2EWindow]::keybd_event(0x4E,0,0,[UIntPtr]::Zero)
        [NativeE2EWindow]::keybd_event(0x4E,0,2,[UIntPtr]::Zero)
        [NativeE2EWindow]::keybd_event(0x5B,0,2,[UIntPtr]::Zero)
        $result=@{ok=$true}
      } elseif($request.action -eq 'systemWindows') {
        $result=@{ok=$true;windows=[NativeE2EWindow]::Windows()}
      } elseif($request.action -eq 'foreground') {
        $handle=[NativeE2EWindow]::GetForegroundWindow().ToInt64()
        $result=@{ok=$true;window=([NativeE2EWindow]::Windows() | Where-Object {$_.handle -eq $handle})}
      } elseif($request.action -in @('externalSnapshot','externalKeys','externalPaste','externalInvoke')) {
        $matches=@([NativeE2EWindow]::Windows() | Where-Object {$_.type -eq [string]$request.windowClass})
        # Page titles change during normal navigation. An observed HWND and
        # class identify the actual browser window across that title change.
        if($request.windowHandle){$matches=@($matches | Where-Object {$_.handle -eq [long]$request.windowHandle})}
        else{$matches=@($matches | Where-Object {$_.text -eq [string]$request.window})}
        if($matches.Count -ne 1){throw 'External window must match one observed title and class'}
        $external=[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$matches[0].handle)
        if($request.action -eq 'externalInvoke') {
          if(-not $request.windowHandle){throw 'Invoking an external native control requires its observed HWND'}
          $match=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$request.controlName)
          $controls=$external.FindAll([System.Windows.Automation.TreeScope]::Descendants,$match)
          if($controls.Count -ne 1){throw 'Expected one matching native permission control'}
          $controls[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
          $result=@{ok=$true}
        } elseif($request.action -in @('externalKeys','externalPaste')) {
          [NativeE2EWindow]::SetForegroundWindow([IntPtr]$matches[0].handle) | Out-Null
          if($request.action -eq 'externalPaste') {
            [System.Windows.Forms.Clipboard]::SetText([string]$request.value)
            [System.Windows.Forms.SendKeys]::SendWait('^v')
          } else { [System.Windows.Forms.SendKeys]::SendWait([string]$request.keys) }
          $result=@{ok=$true}
        } else {
          $children=$external.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
          $controls=@($children | ForEach-Object {
            $description=DescribeElement $_
            if($_.Current.ClassName -eq 'TermControl') {
              $pattern=$null
              if($_.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern,[ref]$pattern)){$description.text=$pattern.DocumentRange.GetText(20000)}
            }
            $description
          })
          $result=@{ok=$true;window=(DescribeElement $external);controls=$controls}
        }
      } elseif($request.action -eq 'shellRoots') {
        $roots=[System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,[System.Windows.Automation.Condition]::TrueCondition)
        $result=@{ok=$true;windows=@($roots | ForEach-Object {DescribeElement $_})}
      } elseif($request.action -eq 'shellClick') {
        $roots=@([NativeE2EWindow]::Windows() | Where-Object {$_.type -eq [string]$request.shellClass} | ForEach-Object {[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$_.handle)})
        $shell=@($roots | Where-Object {$_.Current.ClassName -eq [string]$request.shellClass})
        if($shell.Count -ne 1){throw 'Expected one shell surface'}
        if($request.shellClass -notin @('Shell_TrayWnd','NotifyIconOverflowWindow','TopLevelWindowForOverflowXamlIsland')){throw 'Unsupported shell surface'}
        $match=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,[string]$request.controlName)
        $controls=$shell[0].FindAll([System.Windows.Automation.TreeScope]::Descendants,$match)
        if($controls.Count -ne 1){throw 'Expected one live shell control'}
        $control=$controls[0]
        if($control.Current.IsOffscreen -or -not $control.Current.IsEnabled){throw 'Shell control is not visible and enabled'}
        $bounds=$control.Current.BoundingRectangle
        if($bounds.Width -le 0 -or $bounds.Height -le 0){throw 'Shell control has no visible bounds'}
        [NativeE2EWindow]::SetCursorPos([int]($bounds.X+$bounds.Width/2),[int]($bounds.Y+$bounds.Height/2)) | Out-Null
        $down=if($request.button -eq 'right'){8}else{2}
        $up=if($request.button -eq 'right'){16}else{4}
        [NativeE2EWindow]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
        [NativeE2EWindow]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
        $result=@{ok=$true;control=(DescribeElement $control)}
      } elseif($request.action -eq 'shellSnapshot') {
        # Read only the shell surfaces needed for tray/notification acceptance.
        # Win11 XAML surfaces can be missing from UIA RootElement.Children;
        # resolve their real visible HWNDs before querying accessibility.
        $shell=@([NativeE2EWindow]::Windows() | Where-Object {$_.type -in @('Shell_TrayWnd','NotifyIconOverflowWindow','TopLevelWindowForOverflowXamlIsland','XamlExplorerHostIslandWindow_WASDK') -or $_.text -in @('Windows 输入体验','Windows Input Experience','通知中心','Notification Center','新通知','New notification')} | ForEach-Object {[System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$_.handle)})
        $tree=@()
        foreach($item in $shell){
          $children=$item.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
          $tree+=@{window=(DescribeElement $item);controls=@($children | ForEach-Object {DescribeElement $_})}
        }
        $result=@{ok=$true;windows=$tree}
      } elseif($request.action -eq 'snapshot') {
        if($request.window){$windows=@($windows | Where-Object {$_.Current.Name -eq $request.window})}
        $tree=@()
        foreach($window in $windows){
          $children=$window.FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
          $tree+=@{window=(DescribeElement $window);controls=@($children | ForEach-Object {DescribeElement $_})}
        }
        $result=@{ok=$true;windows=$tree}
      } elseif($request.action -eq 'screenshot') {
        $bounds=[System.Windows.Forms.SystemInformation]::VirtualScreen
        $bitmap=New-Object System.Drawing.Bitmap($bounds.Width,$bounds.Height)
        $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bitmap.Size)
        $destination=Join-Path $outbox ($request.id+'.png')
        $bitmap.Save($destination,[System.Drawing.Imaging.ImageFormat]::Png)
        $graphics.Dispose();$bitmap.Dispose()
        $result=@{ok=$true;path=$destination}
      } elseif($request.action -eq 'clipboard') {
        $result=@{ok=$true;text=[System.Windows.Forms.Clipboard]::GetText()}
      } elseif($request.action -eq 'clipboardImage') {
        $bitmap=New-Object System.Drawing.Bitmap(96,64)
        $graphics=[System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.Clear([System.Drawing.Color]::RoyalBlue)
        $graphics.FillRectangle([System.Drawing.Brushes]::Orange,24,16,48,32)
        $destination=Join-Path (Join-Path $Root 'workspace') ($request.id+'.png')
        $bitmap.Save($destination,[System.Drawing.Imaging.ImageFormat]::Png)
        [System.Windows.Forms.Clipboard]::SetImage($bitmap)
        $graphics.Dispose();$bitmap.Dispose()
        $result=@{ok=$true;path=$destination;width=96;height=64}
      } else {
        $window=@($windows | Where-Object {$_.Current.Name -eq $request.window})
        if($request.windowHandle){$window=@($window | Where-Object {$_.Current.NativeWindowHandle -eq [int]$request.windowHandle})}
        if($window.Count -ne 1){throw "Expected one installed-app window named '$($request.window)', found $($window.Count)"}
        if($request.action -eq 'menuItems') {
          $result=@{ok=$true;items=[NativeE2EWindow]::MenuItems([IntPtr]$window[0].Current.NativeWindowHandle)}
        } elseif($request.action -eq 'clickMenuItem') {
          $items=@([NativeE2EWindow]::MenuItems([IntPtr]$window[0].Current.NativeWindowHandle) | Where-Object {$_.text -eq [string]$request.controlName})
          if($items.Count -ne 1){throw 'Expected one matching native menu item'}
          $item=$items[0]
          if($item.right -le $item.left -or $item.bottom -le $item.top){throw 'Native menu item has no visible bounds'}
          [NativeE2EWindow]::SetCursorPos([int](($item.left+$item.right)/2),[int](($item.top+$item.bottom)/2)) | Out-Null
          [NativeE2EWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
          [NativeE2EWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
        } elseif($request.action -eq 'windowControls') {
          $result=@{ok=$true;controls=[NativeE2EWindow]::Controls([IntPtr]$window[0].Current.NativeWindowHandle)}
        } elseif($request.action -eq 'activate') {
          [NativeE2EWindow]::SetForegroundWindow([IntPtr]$window[0].Current.NativeWindowHandle) | Out-Null
        } elseif($request.action -eq 'focusTitleBar') {
          if($window[0].Current.ClassName -ne 'Tauri Window'){throw 'Title-bar focus is limited to the actual Desktop window'}
          $handle=[IntPtr]$window[0].Current.NativeWindowHandle
          $bounds=New-Object NativeE2EWindow+Rect
          if(-not [NativeE2EWindow]::GetWindowRect($handle,[ref]$bounds)){throw 'Cannot read actual Desktop bounds'}
          [NativeE2EWindow]::SetCursorPos([int](($bounds.left+$bounds.right)/2),[int]($bounds.top+12)) | Out-Null
          [NativeE2EWindow]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
          [NativeE2EWindow]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
        } elseif($request.action -eq 'setControlText') {
          $controls=@([NativeE2EWindow]::Controls([IntPtr]$window[0].Current.NativeWindowHandle) | Where-Object {$_.id -eq [int]$request.controlId -and $_.type -eq 'Edit'})
          if($controls.Count -ne 1){throw 'Native edit must resolve to one visible control'}
          [NativeE2EWindow]::SendMessage([IntPtr]$controls[0].handle,0xC,[IntPtr]::Zero,[string]$request.value) | Out-Null
        } elseif($request.action -eq 'clickButton') {
          $controls=@([NativeE2EWindow]::Controls([IntPtr]$window[0].Current.NativeWindowHandle) | Where-Object {$_.id -eq [int]$request.controlId -and $_.type -eq 'Button'})
          if($controls.Count -ne 1){throw 'Native button must resolve to one visible control'}
          [NativeE2EWindow]::SetForegroundWindow([IntPtr]$window[0].Current.NativeWindowHandle) | Out-Null
          [NativeE2EWindow]::SendMessage([IntPtr]$controls[0].handle,0xF5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
        } elseif($request.action -eq 'windowState') {
          $state=@{normal=9;maximized=3;minimized=6}[[string]$request.state]
          if($null -eq $state){throw 'Unknown window state'}
          [NativeE2EWindow]::ShowWindowAsync([IntPtr]$window[0].Current.NativeWindowHandle,$state) | Out-Null
        } elseif($request.action -eq 'paste') {
          [NativeE2EWindow]::SetForegroundWindow([IntPtr]$window[0].Current.NativeWindowHandle) | Out-Null
          [System.Windows.Forms.Clipboard]::SetText([string]$request.value)
          [System.Windows.Forms.SendKeys]::SendWait('^v')
        } elseif($request.action -eq 'keys') {
          [NativeE2EWindow]::SetForegroundWindow([IntPtr]$window[0].Current.NativeWindowHandle) | Out-Null
          [System.Windows.Forms.SendKeys]::SendWait($request.keys)
        } else {
          $property=if($request.controlId){[System.Windows.Automation.AutomationElement]::AutomationIdProperty}else{[System.Windows.Automation.AutomationElement]::NameProperty}
          $value=if($request.controlId){[string]$request.controlId}else{[string]$request.controlName}
          $match=New-Object System.Windows.Automation.PropertyCondition($property,$value)
          $controls=$window[0].FindAll([System.Windows.Automation.TreeScope]::Descendants,$match)
          if($controls.Count -ne 1){throw "Expected one control '$value', found $($controls.Count)"}
          if($request.action -eq 'setValue') {
            $pattern=$controls[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $pattern.SetValue([string]$request.value)
          } elseif($request.action -eq 'invoke') {
            $pattern=$controls[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
            $pattern.Invoke()
          } else {throw "Unknown action: $($request.action)"}
        }
        if($request.action -notin @('windowControls','menuItems')){$result=@{ok=$true}}
      }
    } catch {$result=@{ok=$false;error=$_.Exception.Message}}
    $json=$result | ConvertTo-Json -Depth 12
    [IO.File]::WriteAllText((Join-Path $outbox $file.Name),$json,[Text.UTF8Encoding]::new($false))
    Remove-Item $file.FullName
  }
  Start-Sleep -Milliseconds 150
}
