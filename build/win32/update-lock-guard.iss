function UpdateOpenProcess(DesiredAccess: Cardinal; InheritHandle: Boolean; ProcessId: Cardinal): THandle;
  external 'OpenProcess@kernel32.dll stdcall';
function UpdateWaitForSingleObject(Handle: THandle; Milliseconds: Cardinal): Cardinal;
  external 'WaitForSingleObject@kernel32.dll stdcall';
function UpdateCloseHandle(Handle: THandle): Boolean;
  external 'CloseHandle@kernel32.dll stdcall';
function UpdateCreateFile(FileName: String; DesiredAccess, ShareMode: Cardinal; SecurityAttributes: Integer; CreationDisposition, FlagsAndAttributes: Cardinal; TemplateFile: THandle): THandle;
  external 'CreateFileW@kernel32.dll stdcall';
function UpdateLastError(): Cardinal;
  external 'GetLastError@kernel32.dll stdcall';

var
  UpdateOwnerHandle: THandle;
  UpdateOwnerCaptureFailed: Boolean;
  UpdateReplacementFailed: Boolean;

function CaptureUpdateOwner(): Boolean;
var
  Owner: Integer;
  Value: String;
begin
  Result := True;
  if not IsBackgroundUpdate() then exit;
  Value := ExpandConstant('{param:updatepid|}');
  if Value = '' then exit;
  Owner := StrToIntDef(Value, 0);
  if Owner <= 0 then begin
    Result := False;
    UpdateOwnerCaptureFailed := True;
    Log('Update owner PID is invalid; refusing installation.');
    exit;
  end;
  UpdateOwnerHandle := UpdateOpenProcess($00100000, False, Owner);
  if UpdateOwnerHandle = 0 then begin
    if UpdateLastError() <> 87 then begin
      Result := False;
      UpdateOwnerCaptureFailed := True;
      Log('Unable to observe update owner exit; refusing installation.');
    end;
  end;
end;

function UpdateCancelled(): Boolean;
begin
  Result := FileExists(ExpandConstant('{param:cancel|}')) or FileExists(ExpandConstant('{param:sessionend|}'));
end;

function WaitForUpdateOwnerExit(): Boolean;
var
  Status: Cardinal;
begin
  Result := False;
  if UpdateOwnerCaptureFailed then exit;
  if UpdateOwnerHandle <> 0 then begin
    Log('Waiting for the original application process to terminate.');
    repeat
      if UpdateCancelled() then exit;
      Status := UpdateWaitForSingleObject(UpdateOwnerHandle, 1000);
      if (Status <> 0) and (Status <> 258) then begin
        Log('Application process wait failed; refusing replacement.');
        exit;
      end;
    until Status = 0;
    UpdateCloseHandle(UpdateOwnerHandle);
    UpdateOwnerHandle := 0;
  end;
  Result := not UpdateCancelled();
end;

function WaitForUpdateArchiveUnlock(): Boolean;
var
  Archive: String;
  Handle: THandle;
  ErrorCode: Cardinal;
  Attempt: Integer;
begin
  Result := False;
  Archive := ExpandConstant('{app}\{#VersionedResourcesFolder}\resources\app\node_modules.asar');
  for Attempt := 1 to 30 do begin
    if UpdateCancelled() then exit;
    Handle := UpdateCreateFile(Archive, $80000000, 0, 0, 3, 0, 0);
    if Handle <> THandle(-1) then begin
      UpdateCloseHandle(Handle);
      Result := True;
      exit;
    end;
    ErrorCode := UpdateLastError();
    if (ErrorCode = 2) or (ErrorCode = 3) then begin
      Result := True;
      exit;
    end;
    if (ErrorCode <> 32) and (ErrorCode <> 33) then begin
      Log('Archive preflight failed with error ' + IntToStr(ErrorCode));
      exit;
    end;
    Log('Archive still in use; waiting before replacement (' + IntToStr(Attempt) + '/30).');
    Sleep(1000);
  end;
  Log('Archive remains locked; original installation has not been replaced.');
end;

procedure DeinitializeSetup();
begin
  if UpdateOwnerHandle <> 0 then begin
    UpdateCloseHandle(UpdateOwnerHandle);
    UpdateOwnerHandle := 0;
  end;
end;
