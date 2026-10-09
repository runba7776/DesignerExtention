param([switch]$CheckRegistration)
$ErrorActionPreference = 'Stop'
$assembly = [Reflection.Assembly]::LoadFrom((Join-Path $PSScriptRoot 'bin/DesignerExtension.AddIn.dll'))
$contract = $assembly.GetType('DesignerExtension.Native.IDTExtensibility2', $true)
if (-not $contract.IsImport -or $contract.GUID -ne [Guid]'B65AD801-ABAF-11D0-BB8B-00A0C90F2744') { throw 'Invalid Extensibility COM identity.' }
if ($contract.GetMethods().Count -ne 5) { throw 'Invalid Extensibility method count.' }
foreach ($method in $contract.GetMethods()) {
    $parameter = $method.GetParameters()[-1]
    $marshal = $parameter.GetCustomAttributes([Runtime.InteropServices.MarshalAsAttribute], $false)[0]
    if (-not $parameter.ParameterType.IsByRef -or $marshal.Value -ne [Runtime.InteropServices.UnmanagedType]::SafeArray -or $marshal.SafeArraySubType -ne [Runtime.InteropServices.VarEnum]::VT_VARIANT) {
        throw ('Incorrect SAFEARRAY(VARIANT)* ABI: ' + $method.Name)
    }
}
$ribbon = $assembly.GetType('DesignerExtension.Native.IRibbonExtensibility', $true)
if (-not $ribbon.IsImport -or $ribbon.GUID -ne [Guid]'000C0396-0000-0000-C000-000000000046') { throw 'Invalid Ribbon COM identity.' }
$instance = $assembly.CreateInstance('DesignerExtension.Native.Connect')
[xml]$xml = $instance.GetCustomUI('Microsoft.PowerPoint.Presentation')
if ($xml.DocumentElement.LocalName -ne 'customUI') { throw 'Invalid ribbon XML.' }
if ($CheckRegistration) {
    $comType = [Type]::GetTypeFromProgID('DesignerExtension.Connect', $true)
    $comInstance = [Activator]::CreateInstance($comType)
    if ($comInstance.GetCustomUI('Microsoft.PowerPoint.Presentation') -ne $xml.OuterXml) {
        [xml]$registeredXml = $comInstance.GetCustomUI('Microsoft.PowerPoint.Presentation')
        if ($registeredXml.DocumentElement.LocalName -ne 'customUI') { throw 'Registered COM object failed.' }
    }
}
Write-Output 'PASS: Office COM ABI, ribbon XML and requested registration checks.'
