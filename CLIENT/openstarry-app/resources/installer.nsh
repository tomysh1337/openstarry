!include "nsDialogs.nsh"
!include "LogicLib.nsh"

!ifdef BUILD_UNINSTALLER

Var KeepOpenStarryDataCheckbox
Var KeepOpenStarryDataState

UninstPage custom un.OpenStarryDataPage un.OpenStarryDataPageLeave

Function un.OpenStarryDataPage
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 24u "本地数据包含聊天记录、附件、设置、密码库和任务历史。"
  Pop $0

  ${NSD_CreateCheckbox} 0 32u 100% 14u "保留 OpenStarry NextGen 本地数据"
  Pop $KeepOpenStarryDataCheckbox
  ${NSD_Check} $KeepOpenStarryDataCheckbox

  nsDialogs::Show
FunctionEnd

Function un.OpenStarryDataPageLeave
  ${NSD_GetState} $KeepOpenStarryDataCheckbox $KeepOpenStarryDataState
FunctionEnd

!macro customUnInstall
  ${If} $KeepOpenStarryDataState != ${BST_CHECKED}
    RMDir /r "$LOCALAPPDATA\OpenStarry NextGen"
  ${EndIf}
!macroend

!endif
