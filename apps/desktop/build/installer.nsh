; mockix:// for the current user. The app registers it again on every start
; (app.setAsDefaultProtocolClient); the installer does it too so a link from
; Sendix works before the first start, and the uninstaller removes it only if
; it still points to this installation.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\mockix" "" "URL:mockix"
  WriteRegStr HKCU "Software\Classes\mockix" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\mockix\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
!macroend

!macro customUnInstall
  ReadRegStr $0 HKCU "Software\Classes\mockix\shell\open\command" ""
  StrCmp $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 +2
    DeleteRegKey HKCU "Software\Classes\mockix"
!macroend
