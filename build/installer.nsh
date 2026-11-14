; ============================================================
; Scripts NSIS personalizados de Eryon Launcher.
; ============================================================
; 1) customCheckAppRunning: al instalar o desinstalar, además de
;    cerrar Eryon Launcher, cierra las ventanas auxiliares de
;    PowerShell de versiones anteriores (update-window.ps1). Esas
;    ventanas mantienen logo-splash.png abierto y provocaban el
;    error "Fallo al desinstalar archivos antiguos...: 2".
; 2) customRemoveFiles: durante la actualización borra la carpeta
;    del programa directamente, en lugar del esquema de renombrado
;    que abortaba con ese mismo error si algún archivo seguía
;    bloqueado. Con el borrado directo, un archivo bloqueado solo
;    queda como residuo y la instalación continúa con normalidad.
; ============================================================

!include "getProcessInfo.nsh"
Var pid

!macro customCheckAppRunning
  !insertmacro IS_POWERSHELL_AVAILABLE

  ${if} $IsPowerShellAvailable == 0
    # Cierra cualquier ventana auxiliar de actualización que siga
    # viva de una versión anterior. Se excluye el propio proceso
    # ($PID) porque su línea de comandos contiene el mismo texto.
    nsExec::Exec `"$PowerShellPath" -NoProfile -C "Get-CimInstance Win32_Process | ? { $$_.Name -eq 'powershell.exe' -and $$_.ProcessId -ne $$PID -and $$_.CommandLine -like '*update-window.ps1*' } | % { Stop-Process -Id $$_.ProcessId -Force }"`
    Pop $0
  ${endIf}

  # Cierre estándar de Eryon Launcher (con reintentos y forzado).
  !insertmacro _CHECK_APP_RUNNING
!macroend

!macro customRemoveFiles
  SetOutPath $TEMP
  RMDir /r "$INSTDIR"
!macroend
