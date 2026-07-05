param ([string] $NavIde)

# If $NavIde is not provided try to find finsql in:
#    1) the current folder, or
#    2) RTC's installation folder.
if (-not $NavIde)
{
    if (Test-Path (Join-Path $PSScriptRoot finsql.exe))
    {
        $NavIde = (Join-Path $PSScriptRoot finsql.exe)
    }
    else
    {
        if ([Environment]::Is64BitProcess)
        {
            $RtcKey = 'HKLM:\SOFTWARE\Wow6432Node\Microsoft\Microsoft Dynamics NAV\90\RoleTailored Client'
        }
        else
        {
            $RtcKey = 'HKLM:\SOFTWARE\Microsoft\Microsoft Dynamics NAV\90\RoleTailored Client'
        }

        if (Test-Path $RtcKey)
        {
            $NavIde = (Join-Path (Get-ItemProperty $RtcKey).Path finsql.exe)
        }
    }
}

if ($NavIde -and (Test-Path $NavIde))
{
	$NavClientPath = (Get-Item $NavIde).DirectoryName
}

<#
    .SYNOPSIS
    Imports NAV application objects from a file into a database.

    .DESCRIPTION
    The Import-NAVApplicationObject function imports the objects from the specified file(s) into the specified database. When multiple files are specified, finsql is invoked for each file. For better performance the files can be joined first. However, using seperate files can be useful for analyzing import errors.

    .INPUTS
    System.String[]
    You can pipe a path to the Import-NavApplicationObject function.

    .OUTPUTS
    None

    .EXAMPLE
    Import-NAVApplicationObject MyAppSrc.txt MyApp
    This command imports all application objects in MyAppSrc.txt into the MyApp database.

    .EXAMPLE
    Import-NAVApplicationObject MyAppSrc.txt -DatabaseName MyApp
    This command imports all application objects in MyAppSrc.txt into the MyApp database.

    .EXAMPLE
    Get-ChildItem MyAppSrc | Import-NAVApplicationObject -DatabaseName MyApp
    This commands imports all objects in all files in the MyAppSrc folder into the MyApp database. The files are imported one by one.

    .EXAMPLE
    Get-ChildItem MyAppSrc | Join-NAVApplicationObject -Destination .\MyAppSrc.txt -PassThru | Import-NAVApplicationObject -Database MyApp
    This commands joins all objects in all files in the MyAppSrc folder into a single file and then imports them in the MyApp database.
#>
function Import-NAVApplicationObject
{
    [CmdletBinding(DefaultParameterSetName="All", SupportsShouldProcess=$true, ConfirmImpact='High')]
    Param(
        # Specifies one or more files to import.  
        [Parameter(Mandatory=$true, Position=0, ValueFromPipeline=$true, ValueFromPipelineByPropertyName=$true)]
        [Alias('PSPath')]
        [string[]] $Path,

        # Specifies the name of the database into which you want to import.
        [Parameter(Mandatory=$true, Position=1)]
        [string] $DatabaseName,

        # Specifies the name of the SQL server instance to which the database you want to import into is attached. The default value is the default instance on the local host (.).
        [ValidateNotNullOrEmpty()]
        [string] $DatabaseServer = '.',

        # Specifies the log folder.
        [ValidateNotNullOrEmpty()]
        [string] $LogPath = "$Env:TEMP\NavIde\$([GUID]::NewGuid().GUID)",

        # Specifies the import action. The default value is 'Default'.
        [ValidateSet('Default','Overwrite','Skip')] [string] $ImportAction = 'Default',

        # Specifies the schema synchronization behaviour. The default value is 'Yes'.
        [ValidateSet('Yes','No','Force')] [string] $SynchronizeSchemaChanges = 'Yes',

        # The user name to use to authenticate to the database. The user name must exist in the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Username,

        # The password to use with the username parameter to authenticate to the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Password,

        # Specifies the name of the server that hosts the Microsoft Dynamics NAV Server instance, such as MyServer.
        [ValidateNotNullOrEmpty()]
        [string] $NavServerName,

        # Specifies the Microsoft Dynamics NAV Server instance that is being used.The default value is DynamicsNAV90.
        [ValidateNotNullOrEmpty()]
        [string] $NavServerInstance = "DynamicsNAV90",

        # Specifies the port on the Microsoft Dynamics NAV Server server that the Microsoft Dynamics NAV Windows PowerShell cmdlets access. The default value is 7045.
        [ValidateNotNullOrEmpty()]
        [int16]  $NavServerManagementPort = 7045)

    PROCESS
    {
        if ($Path.Count -eq 1)
        {
            $Path = (Get-Item $Path).FullName
        }

        if ($PSCmdlet.ShouldProcess(
            "Import application objects from $Path into the $DatabaseName database.",
            "Import application objects from $Path into the $DatabaseName database. If you continue, you may loose data in fields that are removed or changed in the imported file.",
            'Confirm'))
        {
            $navServerInfo = GetNavServerInfo $NavServerName $NavServerInstance $NavServerManagementPort

            foreach ($file in $Path)
            {
                # Log file name is based on the name of the imported file.
                $logFile = "$LogPath\$((Get-Item $file).BaseName).log"
                $command = "Command=ImportObjects`,ImportAction=$ImportAction`,SynchronizeSchemaChanges=$SynchronizeSchemaChanges`,File=`"$file`"" 

                try
                {
                    RunNavIdeCommand -Command $command `
                                     -DatabaseServer $DatabaseServer `
                                     -DatabaseName $DatabaseName `
                                     -NTAuthentication:($Username -eq $null) `
                                     -Username $Username `
                                     -Password $Password `
                                     -NavServerInfo $navServerInfo `
                                     -LogFile $logFile `
                                     -ErrText "Error while importing $file" `
                                     -Verbose:$VerbosePreference
                }
                catch
                {
                    Write-Error $_
                }
            }
        }
    }
}

function GetNavServerInfo
(
    [string] $NavServerName,
    [string] $NavServerInstance,
    [int16]  $NavServerManagementPort
)
{
    $navServerInfo = ""
    if ($navServerName)
    {
        $navServerInfo = @"
`,NavServerName="$NavServerName"`,NavServerInstance="$NavServerInstance"`,NavServerManagementport=$NavServerManagementPort
"@
    }

    $navServerInfo
}

function RunNavIdeCommand
{
    [CmdletBinding()]
    Param(
    [string] $Command,
    [string] $DatabaseServer,
    [string] $DatabaseName,
    [switch] $NTAuthentication,
    [string] $Username,
    [string] $Password,
    [string] $NavServerInfo,
    [string] $LogFile,
    [string] $ErrText)

    TestNavIde
    $logPath = (Split-Path $LogFile)

    Remove-Item "$logPath\navcommandresult.txt" -ErrorAction Ignore
    Remove-Item $logFile -ErrorAction Ignore

    $databaseInfo = @"
ServerName="$DatabaseServer"`,Database="$DatabaseName"
"@
    if ($Username)
    {
        $databaseInfo = @"
ntauthentication=No`,username="$Username"`,password="$Password"`,$databaseInfo
"@
    }

    $finSqlCommand = @"
& "$NavIde" --% $Command`,LogFile="$logFile"`,${databaseInfo}${NavServerInfo} | Out-Null
"@ 

    Write-Verbose "Running command: $finSqlCommand"
    Invoke-Expression -Command  $finSqlCommand
  
    if (Test-Path "$logPath\navcommandresult.txt")
    {
        if (Test-Path $LogFile)
        {
            throw "${ErrorText}: $(Get-Content $LogFile -Raw)" -replace "`r[^`n]","`r`n"
        }
    }
    else
    {
        throw "${ErrorText}!"
    }
}

<#
    .SYNOPSIS    
    Export NAV application objects from a database into a file.

    .DESCRIPTION
    The Export-NAVApplicationObject function exports the objects from the specified database into the specified file. A filter can be specified to select the application objects to be exported.

    .INPUTS
    None
    You cannot pipe input to this function.

    .OUTPUTS
    System.IO.FileInfo
    An object representing the exported file.

    .EXAMPLE
    Export-NAVApplicationObject MyApp MyAppSrc.txt
    Exports all application objects from the MyApp database to MyAppSrc.txt.

    .EXAMPLE
    Export-NAVApplicationObject MyAppSrc.txt -DatabaseName MyApp
    Exports all application objects from the MyApp database to MyAppSrc.txt.

    .EXAMPLE
    Export-NAVApplicationObject MyApp COD1-10.txt -Filter 'Type=Codeunit;Id=1..10'
    Exports codeunits 1..10 from the MyApp database to COD1-10.txt

    .EXAMPLE
    Export-NAVApplicationObject COD1-10.txt -DatabaseName MyApp -Filter 'Type=Codeunit;Id=1..10'
    Exports codeunits 1..10 from the MyApp database to COD1-10.txt

    .EXAMPLE
    Export-NAVApplicationObject COD1-10.txt -DatabaseName MyApp -Filter 'Type=Codeunit;Id=1..10' | Import-NAVApplicationObject -DatabaseName MyApp2
    Copies codeunits 1..10 from the MyApp database to the MyApp2 database.

    .EXAMPLE
    Export-NAVApplicationObject MyAppSrc.txt -DatabaseName MyApp | Split-NAVApplicationObject -Destination MyAppSrc
    Exports all application objects from the MyApp database and splits into single-object files in the MyAppSrc folder.
#>
function Export-NAVApplicationObject
{
    [CmdletBinding(DefaultParameterSetName="All",SupportsShouldProcess = $true)]
    Param(
        # Specifies the name of the database from which you want to export.
        [Parameter(Mandatory=$true, Position=0)]
        [string] $DatabaseName,

        # Specifies the file to export to.
        [Parameter(Mandatory=$true, Position=1)]
        [string] $Path,

        # Specifies the name of the SQL server instance to which the database you want to import into is attached. The default value is the default instance on the local host (.).
        [ValidateNotNullOrEmpty()]
        [string] $DatabaseServer = '.',

        # Specifies the log folder.
        [ValidateNotNullOrEmpty()]
        [string] $LogPath = "$Env:TEMP\NavIde\$([GUID]::NewGuid().GUID)",

        # Specifies the filter that selects the objects to export.
        [string] $Filter,

        # Allows the command to create a file that overwrites an existing file.
        [Switch] $Force,

        # Allows the command to skip application objects that are excluded from license, when exporting as txt.
        [Switch] $ExportTxtSkipUnlicensed,

        # The user name to use to authenticate to the database. The user name must exist in the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Username,

        # The password to use with the username parameter to authenticate to the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Password)

    if ($PSCmdlet.ShouldProcess(
        "Export application objects from $DatabaseName database to $Path.",
        "Export application objects from $DatabaseName database to $Path.",
        'Confirm'))
    {
        if (!$Force -and (Test-Path $Path) -and !$PSCmdlet.ShouldContinue(
            "$Path already exists. If you continue, $Path will be overwritten.",
            'Confirm'))
        {
            Write-Error "$Path already exists."
            return
        }
    }
    else
    {
        return
    }

    $skipUnlicensed = "0"
    if($ExportTxtSkipUnlicensed)
    {
        $skipUnlicensed = "1"
    }

    $command = "Command=ExportObjects`,ExportTxtSkipUnlicensed=$skipUnlicensed`,File=`"$Path`"" 
    if($Filter)
    {
        $command = "$command`,Filter=`"$Filter`""
    }

    $logFile = (Join-Path $logPath naverrorlog.txt)

    try
    {
        RunNavIdeCommand -Command $command `
                         -DatabaseServer $DatabaseServer `
                         -DatabaseName $DatabaseName `
                         -NTAuthentication:($Username -eq $null) `
                         -Username $Username `
                         -Password $Password `
                         -NavServerInfo "" `
                         -LogFile $logFile `
                         -ErrText "Error while exporting $Filter" `
                         -Verbose:$VerbosePreference
        Get-Item $Path 
    }
    catch
    {
        Write-Error $_
    }
}

<#
    .SYNOPSIS
    Deletes NAV application objects from a database.

    .DESCRIPTION
    The Delete-NAVApplicationObject function deletes objects from the specified database. A filter can be specified to select the application objects to be deleted.

    .INPUTS
    None
    You cannot pipe input to this function.

    .OUTPUTS
    None

    .EXAMPLE
    Delete-NAVApplicationObject -DatabaseName MyApp -Filter 'Type=Codeunit;Id=1..10'
    Deletes codeunits 1..10 from the MyApp database
#>
function Delete-NAVApplicationObject
{
    [CmdletBinding(DefaultParameterSetName="All", SupportsShouldProcess=$true, ConfirmImpact='High')]
    Param(
        # Specifies the name of the database from which you want to delete objects.
        [Parameter(Mandatory=$true, Position=0)]
        [string] $DatabaseName,

        # Specifies the name of the SQL server instance to which the database you want to delete objects from is attached. The default value is the default instance on the local host (.).
        [ValidateNotNullOrEmpty()]
        [string] $DatabaseServer = '.',

        # Specifies the log folder.
        [ValidateNotNullOrEmpty()]
        [string] $LogPath = "$Env:TEMP\NavIde\$([GUID]::NewGuid().GUID)",

        # Specifies the filter that selects the objects to delete.
        [string] $Filter,

        # Specifies the schema synchronization behaviour. The default value is 'Yes'.
        [ValidateSet('Yes','No','Force')]
        [string] $SynchronizeSchemaChanges = 'Yes',

        # The user name to use to authenticate to the database. The user name must exist in the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Username,

        # The password to use with the username parameter to authenticate to the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Password,

        # Specifies the name of the server that hosts the Microsoft Dynamics NAV Server instance, such as MyServer.
        [ValidateNotNullOrEmpty()]
        [string] $NavServerName,

        # Specifies the Microsoft Dynamics NAV Server instance that is being used.The default value is DynamicsNAV90.
        [ValidateNotNullOrEmpty()]
        [string] $NavServerInstance = "DynamicsNAV90",

        # Specifies the port on the Microsoft Dynamics NAV Server server that the Microsoft Dynamics NAV Windows PowerShell cmdlets access. The default value is 7045.
        [ValidateNotNullOrEmpty()]
        [int16]  $NavServerManagementPort = 7045)

    if ($PSCmdlet.ShouldProcess(
        "Delete application objects from $DatabaseName database.",
        "Delete application objects from $DatabaseName database.",
        'Confirm'))
    {
        $command = "Command=DeleteObjects`,SynchronizeSchemaChanges=$SynchronizeSchemaChanges"
        if($Filter)
        {
            $command = "$command`,Filter=`"$Filter`""
        } 

        $logFile = (Join-Path $logPath naverrorlog.txt)
        $navServerInfo = GetNavServerInfo $NavServerName $NavServerInstance $NavServerManagementPort

        try
        {
            RunNavIdeCommand -Command $command `
                             -DatabaseServer $DatabaseServer `
                             -DatabaseName $DatabaseName `
                             -NTAuthentication:($Username -eq $null) `
                             -Username $Username `
                             -Password $Password `
                             -NavServerInfo $navServerInfo `
                             -LogFile $logFile `
                             -ErrText "Error while deleting $Filter" `
                             -Verbose:$VerbosePreference
        }
        catch
        {
            Write-Error $_
        }
    }
}

<#
    .SYNOPSIS
    Compiles NAV application objects in a database.

    .DESCRIPTION
    The Compile-NAVApplicationObject function compiles application objects in the specified database. A filter can be specified to select the application objects to be compiled. Unless the Recompile switch is used only uncompiled objects are compiled.

    .INPUTS
    None
    You cannot pipe input to this function.

    .OUTPUTS
    None

    .EXAMPLE
    Compile-NAVApplicationObject MyApp
    Compiles all uncompiled application objects in the MyApp database.

    .EXAMPLE
    Compile-NAVApplicationObject MyApp -Filter 'Type=Codeunit' -Recompile
    Compiles all codeunits in the MyApp database.

    .EXAMPLE
    'Page','Codeunit','Table','XMLport','Report' | % { Compile-NAVApplicationObject -Database MyApp -Filter "Type=$_" -AsJob } | Receive-Job -Wait    
    Compiles all uncompiled Pages, Codeunits, Tables, XMLports, and Reports in the MyApp database in parallel and wait until it is done. Note that some objects may remain uncompiled due to race conditions. Those remaining objects can be compiled in a seperate command.

#>
function Compile-NAVApplicationObject
{
    [CmdletBinding(DefaultParameterSetName="All")]
    Param(
        # Specifies the name of the Dynamics NAV database.
        [Parameter(Mandatory=$true, Position=0)]
        [string] $DatabaseName,

        # Specifies the name of the SQL server instance to which the Dynamics NAV database is attached. The default value is the default instance on the local host (.).
        [ValidateNotNullOrEmpty()]
        [string] $DatabaseServer = '.',

        # Specifies the log folder.
        [ValidateNotNullOrEmpty()]
        [string] $LogPath = "$Env:TEMP\NavIde\$([GUID]::NewGuid().GUID)",

        # Specifies the filter that selects the objects to compile.
        [string] $Filter,

        # Compiles objects that are already compiled.
        [Switch] $Recompile,

        # Compiles in the background returning an object that represents the background job.
        [Switch] $AsJob,
        
        # Specifies the schema synchronization behaviour. The default value is 'Yes'.
        [ValidateSet('Yes','No','Force')]
        [string] $SynchronizeSchemaChanges = 'Yes',

        # The user name to use to authenticate to the database. The user name must exist in the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Username,

        # The password to use with the username parameter to authenticate to the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Password,

        # Specifies the name of the server that hosts the Microsoft Dynamics NAV Server instance, such as MyServer.
        [ValidateNotNullOrEmpty()]
        [string] $NavServerName,

        # Specifies the Microsoft Dynamics NAV Server instance that is being used.The default value is DynamicsNAV90.
        [ValidateNotNullOrEmpty()]
        [string] $NavServerInstance = "DynamicsNAV90",

        # Specifies the port on the Microsoft Dynamics NAV Server server that the Microsoft Dynamics NAV Windows PowerShell cmdlets access. The default value is 7045.
        [ValidateNotNullOrEmpty()]
        [int16]  $NavServerManagementPort = 7045)
    
    if (-not $Recompile)
    {
        $Filter += ';Compiled=0'
        $Filter = $Filter.TrimStart(';')
    }

    if ($AsJob)
    {
        $LogPath = "$LogPath\$([GUID]::NewGuid().GUID)"
        Remove-Item $LogPath -ErrorAction Ignore -Recurse -Confirm:$False -Force
        $scriptBlock =
        {
            Param($ScriptPath,$NavIde,$DatabaseName,$DatabaseServer,$LogPath,$Filter,$Recompile,$SynchronizeSchemaChanges,$Username,$Password,$NavServerName,$NavServerInstance,$NavServerManagementPort,$VerbosePreference)

            Import-Module "$ScriptPath\Microsoft.Dynamics.Nav.Ide.psm1" -ArgumentList $NavIde -Force -DisableNameChecking

            $args = @{
                DatabaseName = $DatabaseName
                DatabaseServer = $DatabaseServer
                LogPath = $LogPath
                Filter = $Filter
                Recompile = $Recompile
                SynchronizeSchemaChanges = $SynchronizeSchemaChanges
            }

            if($Username)
            {
                $args.Add("Username",$Username)
                $args.Add("Password",$Password)
            }

            if($NavServerName)
            {
                $args.Add("NavServerName",$NavServerName)
                $args.Add("NavServerInstance",$NavServerInstance)
                $args.Add("NavServerManagementPort",$NavServerManagementPort)
            }

            Compile-NAVApplicationObject @args -Verbose:$VerbosePreference
        }

        $job = Start-Job $scriptBlock -ArgumentList $PSScriptRoot,$NavIde,$DatabaseName,$DatabaseServer,$LogPath,$Filter,$Recompile,$SynchronizeSchemaChanges,$Username,$Password,$NavServerName,$NavServerInstance,$NavServerManagementPort,$VerbosePreference
        return $job
    }
    else
    {
        try
        {
            $logFile = (Join-Path $LogPath naverrorlog.txt)
            $navServerInfo = GetNavServerInfo $NavServerName $NavServerInstance $NavServerManagementPort     
            $command = "Command=CompileObjects`,SynchronizeSchemaChanges=$SynchronizeSchemaChanges"
            if($Filter)
            {
                $command = "$command,Filter=`"$Filter`""
            }

            RunNavIdeCommand -Command $command `
                             -DatabaseServer $DatabaseServer `
                             -DatabaseName $DatabaseName `
                             -NTAuthentication:($Username -eq $null) `
                             -Username $Username `
                             -Password $Password `
                             -NavServerInfo $navServerInfo `
                             -LogFile $logFile `
                             -ErrText "Error while compiling $Filter" `
                             -Verbose:$VerbosePreference
        }
        catch
        {
            Write-Error $_
        }
    }
}

<#
    .SYNOPSIS
    Creates a new NAV application database.

    .DESCRIPTION
    The Create-NAVDatabase creates a new NAV database that includes the NAV system tables.

    .INPUTS
    None
    You cannot pipe input into this function.

    .OUTPUTS
    None

    .EXAMPLE
    Create-NAVDatabase MyNewApp
    Creates a new NAV database named MyNewApp.

    .EXAMPLE
    Create-NAVDatabase MyNewApp -ServerName "TestComputer01\NAVDEMO" -Collation "da-dk"
    Creates a new NAV database named MyNewApp on TestComputer01\NAVDEMO Sql server with Danish collation.
#>
function Create-NAVDatabase
{
    [CmdletBinding(DefaultParameterSetName="All")]
    Param(
         # Specifies the name of the Dynamics NAV database that will be created.
        [Parameter(Mandatory=$true, Position=0)]
        [string] $DatabaseName,

        # Specifies the name of the SQL server instance on which you want to create the database. The default value is the default instance on the local host (.).
        [ValidateNotNullOrEmpty()]
        [string] $DatabaseServer = '.',

        # Specifies the collation of the database.
        [ValidateNotNullOrEmpty()]
        [string] $Collation,

        # Specifies the log folder.
        [ValidateNotNullOrEmpty()]
        [string] $LogPath = "$Env:TEMP\NavIde\$([GUID]::NewGuid().GUID)",


        # The user name to use to authenticate to the database. The user name must exist in the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Username,

        # The password to use with the username parameter to authenticate to the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Password)

    $logFile = (Join-Path $LogPath naverrorlog.txt)

    $command = "Command=CreateDatabase`,Collation=$Collation"

    try
    {
        RunNavIdeCommand -Command $command `
                         -DatabaseServer $DatabaseServer `
                         -DatabaseName $DatabaseName `
                         -NTAuthentication:($Username -eq $null) `
                         -Username $Username `
                         -Password $Password `
                         -NavServerInfo $navServerInfo `
                         -LogFile $logFile `
                         -ErrText "Error while creating $DatabaseName" `
                         -Verbose:$VerbosePreference
    }
    catch
    {
        Write-Error $_
    }
}

<#
    .SYNOPSIS
    Performs a technical upgrade of a database from a previous version of Microsoft Dynamics NAV.

    .DESCRIPTION
    Performs a technical upgrade of a database from a previous version of Microsoft Dynamics NAV.

    .INPUTS
    None
    You cannot pipe input into this function.

    .OUTPUTS
    None

    .EXAMPLE
    Invoke-NAVDatabaseConversion MyApp
    Perform the technical upgrade on a NAV database named MyApp.

    .EXAMPLE
    Invoke-NAVDatabaseConversion MyApp -ServerName "TestComputer01\NAVDEMO"
    Perform the technical upgrade on a NAV database named MyApp on TestComputer01\NAVDEMO Sql server .
#>
function Invoke-NAVDatabaseConversion
{
    [CmdletBinding(DefaultParameterSetName="All")]
    Param(
         # Specifies the name of the Dynamics NAV database that will be created.
        [Parameter(Mandatory=$true, Position=0)]
        [string] $DatabaseName,

        # Specifies the name of the SQL server instance on which you want to create the database. The default value is the default instance on the local host (.).
        [ValidateNotNullOrEmpty()]
        [string] $DatabaseServer = '.',

        # Specifies the log folder.
        [ValidateNotNullOrEmpty()]
        [string] $LogPath = "$Env:TEMP\NavIde\$([GUID]::NewGuid().GUID)",

        # The user name to use to authenticate to the database. The user name must exist in the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Username,

        # The password to use with the username parameter to authenticate to the database. If you do not specify a user name and password, then the command uses the credentials of the current Windows user to authenticate to the database.
        [Parameter(Mandatory=$true, ParameterSetName="DatabaseAuthentication")]
        [string] $Password)

    $logFile = (Join-Path $LogPath naverrorlog.txt)

    $command = "Command=UpgradeDatabase"

    try
    {
        RunNavIdeCommand -Command $command `
                         -DatabaseServer $DatabaseServer `
                         -DatabaseName $DatabaseName `
                         -NTAuthentication:($Username -eq $null) `
                         -Username $Username `
                         -Password $Password `
                         -NavServerInfo "" `
                         -LogFile $logFile `
                         -ErrText "Error while converting $DatabaseName" `
                         -Verbose:$VerbosePreference
    }
    catch
    {
        Write-Error $_
    }
}

function TestNavIde
{
    if (-not $NavIde -or (($NavIde) -and -not (Test-Path $NavIde)))
    {
        throw '$NavIde was not correctly set. Please assign the path to finsql.exe to $NavIde ($NavIde = path).'
    }
}

Export-ModuleMember -Function *-* -Variable Nav*
# SIG # Begin signature block
# MIIdzwYJKoZIhvcNAQcCoIIdwDCCHbwCAQExCzAJBgUrDgMCGgUAMGkGCisGAQQB
# gjcCAQSgWzBZMDQGCisGAQQBgjcCAR4wJgIDAQAABBAfzDtgWUsITrck0sYpfvNR
# AgEAAgEAAgEAAgEAAgEAMCEwCQYFKw4DAhoFAAQUr9398Vmn/yGQPCFG5U7PmiQj
# 66egghhkMIIEwzCCA6ugAwIBAgITMwAAAJqamxbCg9rVwgAAAAAAmjANBgkqhkiG
# 9w0BAQUFADB3MQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQMA4G
# A1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9uMSEw
# HwYDVQQDExhNaWNyb3NvZnQgVGltZS1TdGFtcCBQQ0EwHhcNMTYwMzMwMTkyMTI5
# WhcNMTcwNjMwMTkyMTI5WjCBszELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hp
# bmd0b24xEDAOBgNVBAcTB1JlZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jw
# b3JhdGlvbjENMAsGA1UECxMETU9QUjEnMCUGA1UECxMebkNpcGhlciBEU0UgRVNO
# OkIxQjctRjY3Ri1GRUMyMSUwIwYDVQQDExxNaWNyb3NvZnQgVGltZS1TdGFtcCBT
# ZXJ2aWNlMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApkZzIcoArX4o
# w+UTmzOJxzgIkiUmrRH8nxQVgnNiYyXy7kx7X5moPKzmIIBX5ocSdQ/eegetpDxH
# sNeFhKBOl13fmCi+AFExanGCE0d7+8l79hdJSSTOF7ZNeUeETWOP47QlDKScLir2
# qLZ1xxx48MYAqbSO30y5xwb9cCr4jtAhHoOBZQycQKKUriomKVqMSp5bYUycVJ6w
# POqSJ3BeTuMnYuLgNkqc9eH9Wzfez10Bywp1zPze29i0g1TLe4MphlEQI0fBK3HM
# r5bOXHzKmsVcAMGPasrUkqfYr+u+FZu0qB3Ea4R8WHSwNmSP0oIs+Ay5LApWeh/o
# CYepBt8c1QIDAQABo4IBCTCCAQUwHQYDVR0OBBYEFCaaBu+RdPA6CKfbWxTt3QcK
# IC8JMB8GA1UdIwQYMBaAFCM0+NlSRnAK7UD7dvuzK7DDNbMPMFQGA1UdHwRNMEsw
# SaBHoEWGQ2h0dHA6Ly9jcmwubWljcm9zb2Z0LmNvbS9wa2kvY3JsL3Byb2R1Y3Rz
# L01pY3Jvc29mdFRpbWVTdGFtcFBDQS5jcmwwWAYIKwYBBQUHAQEETDBKMEgGCCsG
# AQUFBzAChjxodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtpL2NlcnRzL01pY3Jv
# c29mdFRpbWVTdGFtcFBDQS5jcnQwEwYDVR0lBAwwCgYIKwYBBQUHAwgwDQYJKoZI
# hvcNAQEFBQADggEBAIl6HAYUhsO/7lN8D/8YoxYAbFTD0plm82rFs1Mff9WBX1Hz
# /PouqK/RjREf2rdEo3ACEE2whPaeNVeTg94mrJvjzziyQ4gry+VXS9ZSa1xtMBEC
# 76lRlsHigr9nq5oQIIQUqfL86uiYglJ1fAPe3FEkrW6ZeyG6oSos9WPEATTX5aAM
# SdQK3W4BC7EvaXFT8Y8Rw+XbDQt9LJSGTWcXedgoeuWg7lS8N3LxmovUdzhgU6+D
# ZJwyXr5XLp2l5nvx6Xo0d5EedEyqx0vn3GrheVrJWiDRM5vl9+OjuXrudZhSj9WI
# 4qu3Kqx+ioEpG9FwqQ8Ps2alWrWOvVy891W8+RAwggYHMIID76ADAgECAgphFmg0
# AAAAAAAcMA0GCSqGSIb3DQEBBQUAMF8xEzARBgoJkiaJk/IsZAEZFgNjb20xGTAX
# BgoJkiaJk/IsZAEZFgltaWNyb3NvZnQxLTArBgNVBAMTJE1pY3Jvc29mdCBSb290
# IENlcnRpZmljYXRlIEF1dGhvcml0eTAeFw0wNzA0MDMxMjUzMDlaFw0yMTA0MDMx
# MzAzMDlaMHcxCzAJBgNVBAYTAlVTMRMwEQYDVQQIEwpXYXNoaW5ndG9uMRAwDgYD
# VQQHEwdSZWRtb25kMR4wHAYDVQQKExVNaWNyb3NvZnQgQ29ycG9yYXRpb24xITAf
# BgNVBAMTGE1pY3Jvc29mdCBUaW1lLVN0YW1wIFBDQTCCASIwDQYJKoZIhvcNAQEB
# BQADggEPADCCAQoCggEBAJ+hbLHf20iSKnxrLhnhveLjxZlRI1Ctzt0YTiQP7tGn
# 0UytdDAgEesH1VSVFUmUG0KSrphcMCbaAGvoe73siQcP9w4EmPCJzB/LMySHnfL0
# Zxws/HvniB3q506jocEjU8qN+kXPCdBer9CwQgSi+aZsk2fXKNxGU7CG0OUoRi4n
# rIZPVVIM5AMs+2qQkDBuh/NZMJ36ftaXs+ghl3740hPzCLdTbVK0RZCfSABKR2YR
# JylmqJfk0waBSqL5hKcRRxQJgp+E7VV4/gGaHVAIhQAQMEbtt94jRrvELVSfrx54
# QTF3zJvfO4OToWECtR0Nsfz3m7IBziJLVP/5BcPCIAsCAwEAAaOCAaswggGnMA8G
# A1UdEwEB/wQFMAMBAf8wHQYDVR0OBBYEFCM0+NlSRnAK7UD7dvuzK7DDNbMPMAsG
# A1UdDwQEAwIBhjAQBgkrBgEEAYI3FQEEAwIBADCBmAYDVR0jBIGQMIGNgBQOrIJg
# QFYnl+UlE/wq4QpTlVnkpKFjpGEwXzETMBEGCgmSJomT8ixkARkWA2NvbTEZMBcG
# CgmSJomT8ixkARkWCW1pY3Jvc29mdDEtMCsGA1UEAxMkTWljcm9zb2Z0IFJvb3Qg
# Q2VydGlmaWNhdGUgQXV0aG9yaXR5ghB5rRahSqClrUxzWPQHEy5lMFAGA1UdHwRJ
# MEcwRaBDoEGGP2h0dHA6Ly9jcmwubWljcm9zb2Z0LmNvbS9wa2kvY3JsL3Byb2R1
# Y3RzL21pY3Jvc29mdHJvb3RjZXJ0LmNybDBUBggrBgEFBQcBAQRIMEYwRAYIKwYB
# BQUHMAKGOGh0dHA6Ly93d3cubWljcm9zb2Z0LmNvbS9wa2kvY2VydHMvTWljcm9z
# b2Z0Um9vdENlcnQuY3J0MBMGA1UdJQQMMAoGCCsGAQUFBwMIMA0GCSqGSIb3DQEB
# BQUAA4ICAQAQl4rDXANENt3ptK132855UU0BsS50cVttDBOrzr57j7gu1BKijG1i
# uFcCy04gE1CZ3XpA4le7r1iaHOEdAYasu3jyi9DsOwHu4r6PCgXIjUji8FMV3U+r
# kuTnjWrVgMHmlPIGL4UD6ZEqJCJw+/b85HiZLg33B+JwvBhOnY5rCnKVuKE5nGct
# xVEO6mJcPxaYiyA/4gcaMvnMMUp2MT0rcgvI6nA9/4UKE9/CCmGO8Ne4F+tOi3/F
# NSteo7/rvH0LQnvUU3Ih7jDKu3hlXFsBFwoUDtLaFJj1PLlmWLMtL+f5hYbMUVbo
# nXCUbKw5TNT2eb+qGHpiKe+imyk0BncaYsk9Hm0fgvALxyy7z0Oz5fnsfbXjpKh0
# NbhOxXEjEiZ2CzxSjHFaRkMUvLOzsE1nyJ9C/4B5IYCeFTBm6EISXhrIniIh0EPp
# K+m79EjMLNTYMoBMJipIJF9a6lbvpt6Znco6b72BJ3QGEe52Ib+bgsEnVLaxaj2J
# oXZhtG6hE6a/qkfwEm/9ijJssv7fUciMI8lmvZ0dhxJkAj0tr1mPuOQh5bWwymO0
# eFQF1EEuUKyUsKV4q7OglnUa2ZKHE3UiLzKoCG6gW4wlv6DvhMoh1useT8ma7kng
# 9wFlb4kLfchpyOZu6qeXzjEp/w7FW1zYTRuh2Povnj8uVRZryROj/TCCBhAwggP4
# oAMCAQICEzMAAABkR4SUhttBGTgAAAAAAGQwDQYJKoZIhvcNAQELBQAwfjELMAkG
# A1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNVBAcTB1JlZG1vbmQx
# HjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEoMCYGA1UEAxMfTWljcm9z
# b2Z0IENvZGUgU2lnbmluZyBQQ0EgMjAxMTAeFw0xNTEwMjgyMDMxNDZaFw0xNzAx
# MjgyMDMxNDZaMIGDMQswCQYDVQQGEwJVUzETMBEGA1UECBMKV2FzaGluZ3RvbjEQ
# MA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMVTWljcm9zb2Z0IENvcnBvcmF0aW9u
# MQ0wCwYDVQQLEwRNT1BSMR4wHAYDVQQDExVNaWNyb3NvZnQgQ29ycG9yYXRpb24w
# ggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCTLtrY5j6Y2RsPZF9NqFhN
# FDv3eoT8PBExOu+JwkotQaVIXd0Snu+rZig01X0qVXtMTYrywPGy01IVi7azCLiL
# UAvdf/tqCaDcZwTE8d+8dRggQL54LJlW3e71Lt0+QvlaHzCuARSKsIK1UaDibWX+
# 9xgKjTBtTTqnxfM2Le5fLKCSALEcTOLL9/8kJX/Xj8Ddl27Oshe2xxxEpyTKfoHm
# 5jG5FtldPtFo7r7NSNCGLK7cDiHBwIrD7huTWRP2xjuAchiIU/urvzA+oHe9Uoi/
# etjosJOtoRuM1H6mEFAQvuHIHGT6hy77xEdmFsCEezavX7qFRGwCDy3gsA4boj4l
# AgMBAAGjggF/MIIBezAfBgNVHSUEGDAWBggrBgEFBQcDAwYKKwYBBAGCN0wIATAd
# BgNVHQ4EFgQUWFZxBPC9uzP1g2jM54BG91ev0iIwUQYDVR0RBEowSKRGMEQxDTAL
# BgNVBAsTBE1PUFIxMzAxBgNVBAUTKjMxNjQyKzQ5ZThjM2YzLTIzNTktNDdmNi1h
# M2JlLTZjOGM0NzUxYzRiNjAfBgNVHSMEGDAWgBRIbmTlUAXTgqoXNzcitW2oynUC
# lTBUBgNVHR8ETTBLMEmgR6BFhkNodHRwOi8vd3d3Lm1pY3Jvc29mdC5jb20vcGtp
# b3BzL2NybC9NaWNDb2RTaWdQQ0EyMDExXzIwMTEtMDctMDguY3JsMGEGCCsGAQUF
# BwEBBFUwUzBRBggrBgEFBQcwAoZFaHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3Br
# aW9wcy9jZXJ0cy9NaWNDb2RTaWdQQ0EyMDExXzIwMTEtMDctMDguY3J0MAwGA1Ud
# EwEB/wQCMAAwDQYJKoZIhvcNAQELBQADggIBAIjiDGRDHd1crow7hSS1nUDWvWas
# W1c12fToOsBFmRBN27SQ5Mt2UYEJ8LOTTfT1EuS9SCcUqm8t12uD1ManefzTJRtG
# ynYCiDKuUFT6A/mCAcWLs2MYSmPlsf4UOwzD0/KAuDwl6WCy8FW53DVKBS3rbmdj
# vDW+vCT5wN3nxO8DIlAUBbXMn7TJKAH2W7a/CDQ0p607Ivt3F7cqhEtrO1Rypehh
# bkKQj4y/ebwc56qWHJ8VNjE8HlhfJAk8pAliHzML1v3QlctPutozuZD3jKAO4WaV
# qJn5BJRHddW6l0SeCuZmBQHmNfXcz4+XZW/s88VTfGWjdSGPXC26k0LzV6mjEaEn
# S1G4t0RqMP90JnTEieJ6xFcIpILgcIvcEydLBVe0iiP9AXKYVjAPn6wBm69FKCQr
# IPWsMDsw9wQjaL8GHk4wCj0CmnixHQanTj2hKRc2G9GL9q7tAbo0kFNIFs0EYkbx
# Cn7lBOEqhBSTyaPS6CvjJZGwD0lNuapXDu72y4Hk4pgExQ3iEv/Ij5oVWwT8okie
# +fFLNcnVgeRrjkANgwoAyX58t0iqbefHqsg3RGSgMBu9MABcZ6FQKwih3Tj0DVPc
# gnJQle3c6xN3dZpuEgFcgJh/EyDXSdppZzJR4+Bbf5XA/Rcsq7g7X7xl4bJoNKLf
# cafOabJhpxfcFOowMIIHejCCBWKgAwIBAgIKYQ6Q0gAAAAAAAzANBgkqhkiG9w0B
# AQsFADCBiDELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAOBgNV
# BAcTB1JlZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEyMDAG
# A1UEAxMpTWljcm9zb2Z0IFJvb3QgQ2VydGlmaWNhdGUgQXV0aG9yaXR5IDIwMTEw
# HhcNMTEwNzA4MjA1OTA5WhcNMjYwNzA4MjEwOTA5WjB+MQswCQYDVQQGEwJVUzET
# MBEGA1UECBMKV2FzaGluZ3RvbjEQMA4GA1UEBxMHUmVkbW9uZDEeMBwGA1UEChMV
# TWljcm9zb2Z0IENvcnBvcmF0aW9uMSgwJgYDVQQDEx9NaWNyb3NvZnQgQ29kZSBT
# aWduaW5nIFBDQSAyMDExMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA
# q/D6chAcLq3YbqqCEE00uvK2WCGfQhsqa+laUKq4BjgaBEm6f8MMHt03a8YS2Avw
# OMKZBrDIOdUBFDFC04kNeWSHfpRgJGyvnkmc6Whe0t+bU7IKLMOv2akrrnoJr9eW
# WcpgGgXpZnboMlImEi/nqwhQz7NEt13YxC4Ddato88tt8zpcoRb0RrrgOGSsbmQ1
# eKagYw8t00CT+OPeBw3VXHmlSSnnDb6gE3e+lD3v++MrWhAfTVYoonpy4BI6t0le
# 2O3tQ5GD2Xuye4Yb2T6xjF3oiU+EGvKhL1nkkDstrjNYxbc+/jLTswM9sbKvkjh+
# 0p2ALPVOVpEhNSXDOW5kf1O6nA+tGSOEy/S6A4aN91/w0FK/jJSHvMAhdCVfGCi2
# zCcoOCWYOUo2z3yxkq4cI6epZuxhH2rhKEmdX4jiJV3TIUs+UsS1Vz8kA/DRelsv
# 1SPjcF0PUUZ3s/gA4bysAoJf28AVs70b1FVL5zmhD+kjSbwYuER8ReTBw3J64HLn
# JN+/RpnF78IcV9uDjexNSTCnq47f7Fufr/zdsGbiwZeBe+3W7UvnSSmnEyimp31n
# gOaKYnhfsi+E11ecXL93KCjx7W3DKI8sj0A3T8HhhUSJxAlMxdSlQy90lfdu+Hgg
# WCwTXWCVmj5PM4TasIgX3p5O9JawvEagbJjS4NaIjAsCAwEAAaOCAe0wggHpMBAG
# CSsGAQQBgjcVAQQDAgEAMB0GA1UdDgQWBBRIbmTlUAXTgqoXNzcitW2oynUClTAZ
# BgkrBgEEAYI3FAIEDB4KAFMAdQBiAEMAQTALBgNVHQ8EBAMCAYYwDwYDVR0TAQH/
# BAUwAwEB/zAfBgNVHSMEGDAWgBRyLToCMZBDuRQFTuHqp8cx0SOJNDBaBgNVHR8E
# UzBRME+gTaBLhklodHRwOi8vY3JsLm1pY3Jvc29mdC5jb20vcGtpL2NybC9wcm9k
# dWN0cy9NaWNSb29DZXJBdXQyMDExXzIwMTFfMDNfMjIuY3JsMF4GCCsGAQUFBwEB
# BFIwUDBOBggrBgEFBQcwAoZCaHR0cDovL3d3dy5taWNyb3NvZnQuY29tL3BraS9j
# ZXJ0cy9NaWNSb29DZXJBdXQyMDExXzIwMTFfMDNfMjIuY3J0MIGfBgNVHSAEgZcw
# gZQwgZEGCSsGAQQBgjcuAzCBgzA/BggrBgEFBQcCARYzaHR0cDovL3d3dy5taWNy
# b3NvZnQuY29tL3BraW9wcy9kb2NzL3ByaW1hcnljcHMuaHRtMEAGCCsGAQUFBwIC
# MDQeMiAdAEwAZQBnAGEAbABfAHAAbwBsAGkAYwB5AF8AcwB0AGEAdABlAG0AZQBu
# AHQALiAdMA0GCSqGSIb3DQEBCwUAA4ICAQBn8oalmOBUeRou09h0ZyKbC5YR4WOS
# mUKWfdJ5DJDBZV8uLD74w3LRbYP+vj/oCso7v0epo/Np22O/IjWll11lhJB9i0ZQ
# VdgMknzSGksc8zxCi1LQsP1r4z4HLimb5j0bpdS1HXeUOeLpZMlEPXh6I/MTfaaQ
# dION9MsmAkYqwooQu6SpBQyb7Wj6aC6VoCo/KmtYSWMfCWluWpiW5IP0wI/zRive
# /DvQvTXvbiWu5a8n7dDd8w6vmSiXmE0OPQvyCInWH8MyGOLwxS3OW560STkKxgrC
# xq2u5bLZ2xWIUUVYODJxJxp/sfQn+N4sOiBpmLJZiWhub6e3dMNABQamASooPoI/
# E01mC8CzTfXhj38cbxV9Rad25UAqZaPDXVJihsMdYzaXht/a8/jyFqGaJ+HNpZfQ
# 7l1jQeNbB5yHPgZ3BtEGsXUfFL5hYbXw3MYbBL7fQccOKO7eZS/sl/ahXJbYANah
# Rr1Z85elCUtIEJmAH9AAKcWxm6U/RXceNcbSoqKfenoi+kiVH6v7RyOA9Z74v2u3
# S5fi63V4GuzqN5l5GEv/1rMjaHXmr/r8i+sLgOppO6/8MO0ETI7f33VtY5E90Z1W
# Tk+/gFcioXgRMiF670EKsT/7qMykXcGhiJtXcVZOSEXAQsmbdlsKgEhr/Xmfwb1t
# bWrJUnMTDXpQzTGCBNUwggTRAgEBMIGVMH4xCzAJBgNVBAYTAlVTMRMwEQYDVQQI
# EwpXYXNoaW5ndG9uMRAwDgYDVQQHEwdSZWRtb25kMR4wHAYDVQQKExVNaWNyb3Nv
# ZnQgQ29ycG9yYXRpb24xKDAmBgNVBAMTH01pY3Jvc29mdCBDb2RlIFNpZ25pbmcg
# UENBIDIwMTECEzMAAABkR4SUhttBGTgAAAAAAGQwCQYFKw4DAhoFAKCB6TAZBgkq
# hkiG9w0BCQMxDAYKKwYBBAGCNwIBBDAcBgorBgEEAYI3AgELMQ4wDAYKKwYBBAGC
# NwIBFTAjBgkqhkiG9w0BCQQxFgQUI7EVTlPDN9fjXPlgOW3+vPgPhOUwgYgGCisG
# AQQBgjcCAQwxejB4oFqAWABNAGkAYwByAG8AcwBvAGYAdAAgAEQAeQBuAGEAbQBp
# AGMAcwAgAE4AQQBWACAAQwBvAGQAZQBzAGkAZwBuACAAUwB1AGIAbQBpAHMAcwBz
# AGkAbwBuAC6hGoAYaHR0cDovL3d3dy5taWNyb3NvZnQuY29tMA0GCSqGSIb3DQEB
# AQUABIIBAG5m9XgRMdhl8N+Va20NmzTJmNq/asmKw4x6DiaFKDbNRD0Y7ENaezC2
# ZX7ql2Fo4bRa1JYLqRmPy93NP9mbq2qgMAkilC2P0UZThGTNE/cDjg4RtqSrerR3
# WYcomm30oXvR9Kh2EnKi4ykVCFON6NAbIEWfM87hOoZudh6pux0Fe5jKmfkUU/G4
# n5C4+RiK0LsYHZZ55yiGtOOWEh9zBh4pQOsvFxHYQGMPS3lFDVrRwxIhF29HBBRZ
# 905NCts+s903fZojaol88kRL5YQnlfXUxCgv/W3LofM+MJyP8jCV3gMy50YA0+Uh
# mmLu1hXWB1cLw7UJl5Tn9k60Q9+K1HihggIoMIICJAYJKoZIhvcNAQkGMYICFTCC
# AhECAQEwgY4wdzELMAkGA1UEBhMCVVMxEzARBgNVBAgTCldhc2hpbmd0b24xEDAO
# BgNVBAcTB1JlZG1vbmQxHjAcBgNVBAoTFU1pY3Jvc29mdCBDb3Jwb3JhdGlvbjEh
# MB8GA1UEAxMYTWljcm9zb2Z0IFRpbWUtU3RhbXAgUENBAhMzAAAAmpqbFsKD2tXC
# AAAAAACaMAkGBSsOAwIaBQCgXTAYBgkqhkiG9w0BCQMxCwYJKoZIhvcNAQcBMBwG
# CSqGSIb3DQEJBTEPFw0xNjA2MjMxNzE4MzdaMCMGCSqGSIb3DQEJBDEWBBSergvn
# R9MiDg0O4GTKCpA5xbtXgjANBgkqhkiG9w0BAQUFAASCAQBPSQ/QIGmNobnJ3d64
# USHzfleo7ANgSiMqblP24ygnAuAlijtIf5NZ9c8uSWOv00iFyUGpA28UXdjZCnbr
# 9PI16Rwn5EdF0vo4IJ/o3CTvXnqExkAjEVeM+2nZYbDHL9XKjRbZADFLnpQkNjrU
# r4qyHvQgR8dfWMTjWIKaoFzh2MoSrVBxUIwvoHp0yNW2+WgjLZOeU7Xe49C3vHSj
# J8EKawA761Hk1IaVHgZLQKzk9ZFX0bJfvultPV2sBRF0vzDLXgeMFNsGAz/DUuHx
# MjN1CzHof8ffvb/4iD8y64neJMKJ3vPv4YP/XCibBfL5b7tsRrQtnD6S1GpO6syC
# eKBb
# SIG # End signature block
