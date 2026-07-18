param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("launch", "keep", "terminate")]
  [string]$Mode,
  [Parameter(Mandatory = $true)]
  [string]$JobName,
  [Parameter(Mandatory = $true)]
  [string]$MarkerPath,
  [string]$Payload,
  [int]$ParentPid
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class PlanWeaveWindowsJob
{
    private const uint JOB_OBJECT_QUERY = 0x0004;
    private const uint JOB_OBJECT_TERMINATE = 0x0008;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectBasicAccountingInformation = 1;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint STARTF_USESHOWWINDOW = 0x00000001;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const short SW_HIDE = 0;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const uint INFINITE = 0xffffffff;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint WAIT_OBJECT_0 = 0;

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr securityAttributes, string name);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObject(uint desiredAccess, bool inheritHandle, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(
        IntPtr job,
        int informationClass,
        IntPtr information,
        uint informationLength,
        IntPtr returnLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint desiredAccess, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll")]
    private static extern IntPtr GetStdHandle(int standardHandle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForMultipleObjects(
        uint count,
        IntPtr[] handles,
        bool waitAll,
        uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    private static Win32Exception Error(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    public static IntPtr CreateOwnedJob(string name)
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, name);
        if (job == IntPtr.Zero) throw Error("CreateJobObject");

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        int size = Marshal.SizeOf(limits);
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            Marshal.StructureToPtr(limits, pointer, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, pointer, (uint)size))
                throw Error("SetInformationJobObject");
            if (!AssignProcessToJobObject(job, GetCurrentProcess()))
                throw Error("AssignProcessToJobObject(current launcher)");
            return job;
        }
        catch
        {
            CloseHandle(job);
            throw;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    public static IntPtr OpenOwnedJob(string name)
    {
        IntPtr job = OpenJobObject(JOB_OBJECT_QUERY | JOB_OBJECT_TERMINATE, false, name);
        if (job == IntPtr.Zero) throw Error("OpenJobObject");
        return job;
    }

    public static IntPtr OpenParent(uint processId)
    {
        IntPtr process = OpenProcess(SYNCHRONIZE, false, processId);
        if (process == IntPtr.Zero) throw Error("OpenProcess(PlanWeave parent)");
        return process;
    }

    public static bool HasExited(IntPtr process)
    {
        uint result = WaitForSingleObject(process, 0);
        if (result == WAIT_OBJECT_0) return true;
        if (result == 0x00000102) return false;
        throw Error("WaitForSingleObject(PlanWeave parent)");
    }

    public static uint ActiveProcesses(IntPtr job)
    {
        int size = Marshal.SizeOf(typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
        IntPtr pointer = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, pointer, (uint)size, IntPtr.Zero))
                throw Error("QueryInformationJobObject");
            var accounting = (JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(
                pointer,
                typeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
            return accounting.ActiveProcesses;
        }
        finally
        {
            Marshal.FreeHGlobal(pointer);
        }
    }

    private static string QuoteArgument(string argument)
    {
        if (argument.Length > 0 && argument.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            return argument;
        var quoted = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                quoted.Append('\\', slashes * 2 + 1);
                quoted.Append('"');
                slashes = 0;
                continue;
            }
            quoted.Append('\\', slashes);
            slashes = 0;
            quoted.Append(character);
        }
        quoted.Append('\\', slashes * 2);
        quoted.Append('"');
        return quoted.ToString();
    }

    private static void AppendBatchLiteralCharacter(
        StringBuilder result,
        char character,
        string literalPercentVariable)
    {
        if (character == '%')
        {
            result.Append('%');
            result.Append(literalPercentVariable);
            result.Append('%');
        }
        else
        {
            result.Append(character);
        }
    }

    private static string QuoteBatchArgument(string argument, string literalPercentVariable)
    {
        if (argument.IndexOfAny(new[] { '\r', '\n' }) >= 0)
            throw new ArgumentException("Batch file arguments cannot contain newlines.");
        const string unquoted = "#$*+-./:?@\\_";
        bool quote = argument.Length == 0 || argument.EndsWith("\\", StringComparison.Ordinal);
        foreach (char character in argument)
        {
            if ((character < 128 && !Char.IsLetterOrDigit(character) && unquoted.IndexOf(character) < 0) ||
                Char.IsControl(character))
                quote = true;
        }
        var result = new StringBuilder();
        if (quote) result.Append('"');
        int slashes = 0;
        foreach (char character in argument)
        {
            if (character == '\\')
            {
                slashes++;
                continue;
            }
            if (character == '"')
            {
                result.Append('\\', slashes * 2);
                result.Append("\"\"");
            }
            else
            {
                result.Append('\\', slashes);
                AppendBatchLiteralCharacter(result, character, literalPercentVariable);
            }
            slashes = 0;
        }
        result.Append('\\', quote ? slashes * 2 : slashes);
        if (quote) result.Append('"');
        return result.ToString();
    }

    private static StringBuilder NativeCommandLine(string executable, string[] arguments)
    {
        var commandLine = new StringBuilder(QuoteArgument(executable));
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteArgument(argument));
        }
        return commandLine;
    }

    private static StringBuilder BatchCommandLine(
        string executable,
        string[] arguments,
        string literalPercentVariable)
    {
        if (executable.IndexOf('"') >= 0 || executable.EndsWith("\\", StringComparison.Ordinal))
            throw new ArgumentException("Invalid batch file path.");
        var commandLine = new StringBuilder("cmd.exe /e:ON /v:OFF /d /c \"\"");
        foreach (char character in executable)
            AppendBatchLiteralCharacter(commandLine, character, literalPercentVariable);
        commandLine.Append('"');
        foreach (string argument in arguments)
        {
            commandLine.Append(' ');
            commandLine.Append(QuoteBatchArgument(argument, literalPercentVariable));
        }
        commandLine.Append('"');
        return commandLine;
    }

    public static uint RunTarget(
        string command,
        string launchMode,
        string commandInterpreter,
        string[] arguments,
        IntPtr parent,
        IntPtr job)
    {
        if (!System.IO.Path.IsPathRooted(command) || !System.IO.File.Exists(command))
            throw new Win32Exception(2, "Resolved target does not exist: " + command);
        bool batch = String.Equals(launchMode, "batch", StringComparison.Ordinal);
        string executable = batch ? commandInterpreter : command;
        if (!System.IO.Path.IsPathRooted(executable) || !System.IO.File.Exists(executable))
            throw new Win32Exception(2, "Resolved launcher does not exist: " + executable);
        string literalPercentVariable = batch
            ? "__PLANWEAVE_LITERAL_PERCENT_" + Guid.NewGuid().ToString("N")
            : null;
        StringBuilder commandLine = batch
            ? BatchCommandLine(command, arguments, literalPercentVariable)
            : NativeCommandLine(command, arguments);
        var startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(startup);
        startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
        startup.wShowWindow = SW_HIDE;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
        PROCESS_INFORMATION process;
        string previousLiteralPercent = batch
            ? Environment.GetEnvironmentVariable(literalPercentVariable)
            : null;
        try
        {
            // cmd expands variables once, so this becomes a literal % without re-expansion.
            if (batch) Environment.SetEnvironmentVariable(literalPercentVariable, "%");
            if (!CreateProcess(
                executable,
                commandLine,
                IntPtr.Zero,
                IntPtr.Zero,
                true,
                0,
                IntPtr.Zero,
                null,
                ref startup,
                out process))
                throw Error("CreateProcess(target)");
        }
        finally
        {
            if (batch) Environment.SetEnvironmentVariable(literalPercentVariable, previousLiteralPercent);
        }
        try
        {
            uint waitResult = WaitForMultipleObjects(
                2,
                new[] { process.hProcess, parent },
                false,
                INFINITE);
            if (waitResult == WAIT_OBJECT_0 + 1)
            {
                Terminate(job);
                throw new InvalidOperationException("PlanWeave parent exited before target.");
            }
            if (waitResult != WAIT_OBJECT_0) throw Error("WaitForMultipleObjects(target/parent)");
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
                throw Error("GetExitCodeProcess(target)");
            return exitCode;
        }
        finally
        {
            CloseHandle(process.hThread);
            CloseHandle(process.hProcess);
        }
    }

    public static void Terminate(IntPtr job)
    {
        if (!TerminateJobObject(job, 1)) throw Error("TerminateJobObject");
    }
}
'@

try {
  if ($Mode -eq "terminate") {
    try {
      $job = [PlanWeaveWindowsJob]::OpenOwnedJob($JobName)
    } catch [ComponentModel.Win32Exception] {
      if ($_.Exception.NativeErrorCode -eq 2) {
        Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
        exit 0
      }
      if ($_.Exception.NativeErrorCode -eq 5) {
        [Console]::Error.WriteLine("PlanWeave Windows Job helper failed: $($_.Exception.Message)")
        exit 2
      }
      throw
    }
    try {
      [PlanWeaveWindowsJob]::Terminate($job)
    } catch [ComponentModel.Win32Exception] {
      if ($_.Exception.NativeErrorCode -eq 5) {
        [Console]::Error.WriteLine("PlanWeave Windows Job helper failed: $($_.Exception.Message)")
        exit 2
      }
      throw
    } finally {
      [PlanWeaveWindowsJob]::CloseHandle($job) | Out-Null
    }
    Remove-Item -LiteralPath $MarkerPath -Force -ErrorAction SilentlyContinue
    exit 0
  }

  if ($Mode -eq "keep") {
    if ($ParentPid -le 0) {
      throw "keep mode requires ParentPid"
    }
    $job = [PlanWeaveWindowsJob]::OpenOwnedJob($JobName)
    $parent = [PlanWeaveWindowsJob]::OpenParent([uint32]$ParentPid)
    try {
      [IO.File]::WriteAllText($MarkerPath, $JobName)
      $readyEvent = [Threading.EventWaitHandle]::OpenExisting($Payload)
      try {
        $readyEvent.Set() | Out-Null
      } finally {
        $readyEvent.Dispose()
      }
      while ([PlanWeaveWindowsJob]::ActiveProcesses($job) -gt 1) {
        if ([PlanWeaveWindowsJob]::HasExited($parent)) {
          Remove-Item -LiteralPath $MarkerPath -Force
          [PlanWeaveWindowsJob]::Terminate($job)
        }
        Start-Sleep -Milliseconds 20
      }
      Remove-Item -LiteralPath $MarkerPath -Force
    } finally {
      [PlanWeaveWindowsJob]::CloseHandle($parent) | Out-Null
      [PlanWeaveWindowsJob]::CloseHandle($job) | Out-Null
    }
    exit 0
  }

  if ([string]::IsNullOrWhiteSpace($Payload)) {
    throw "launch mode requires a payload"
  }
  if ($ParentPid -le 0) {
    throw "launch mode requires ParentPid"
  }
  $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Payload))
  $request = $decoded | ConvertFrom-Json
  if ([string]::IsNullOrWhiteSpace([string]$request.command)) {
    throw "launch payload requires a command"
  }
  $arguments = @($request.args | ForEach-Object { [string]$_ })
  $job = [PlanWeaveWindowsJob]::CreateOwnedJob($JobName)
  $parent = [PlanWeaveWindowsJob]::OpenParent([uint32]$ParentPid)
  $exitCode = [PlanWeaveWindowsJob]::RunTarget(
    [string]$request.command,
    [string]$request.launchMode,
    [string]$request.commandInterpreter,
    $arguments,
    $parent,
    $job
  )

  Start-Sleep -Milliseconds 10
  if ([PlanWeaveWindowsJob]::ActiveProcesses($job) -gt 1) {
    $readyName = "Local\PlanWeaveReady-$([Guid]::NewGuid().ToString('N'))"
    $readyEvent = [Threading.EventWaitHandle]::new(
      $false,
      [Threading.EventResetMode]::ManualReset,
      $readyName
    )
    try {
      $powershell = [Diagnostics.Process]::GetCurrentProcess().MainModule.FileName
      $keeperArgs = @(
        "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
        "-File", "`"$PSCommandPath`"", "-Mode", "keep", "-JobName", $JobName,
        "-MarkerPath", "`"$MarkerPath`"", "-Payload", $readyName,
        "-ParentPid", [string]$ParentPid
      )
      Start-Process -FilePath $powershell -ArgumentList $keeperArgs -WindowStyle Hidden | Out-Null
      $keeperDeadline = [DateTime]::UtcNow.AddSeconds(30)
      while (-not $readyEvent.WaitOne(20)) {
        if ([PlanWeaveWindowsJob]::HasExited($parent)) {
          [PlanWeaveWindowsJob]::Terminate($job)
        }
        if ([DateTime]::UtcNow -ge $keeperDeadline) {
          throw "Timed out waiting for Windows Job keeper ownership."
        }
      }
    } finally {
      $readyEvent.Dispose()
    }
  }

  [Environment]::Exit([int]$exitCode)
} catch {
  [Console]::Error.WriteLine("PlanWeave Windows Job helper failed: $($_.Exception.Message)")
  exit 1
}
