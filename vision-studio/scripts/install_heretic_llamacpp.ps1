#requires -Version 5.1

<#
.SYNOPSIS
Installs the pinned Windows CUDA llama.cpp runtime used by Krea2 Vision.

.DESCRIPTION
Downloads only the two llama.cpp runtime ZIPs declared in the checked-in
artifact manifest. Downloads resume through .partial files and are accepted
only after both the exact byte length and SHA-256 match. The verified archives
are expanded into an owned staging directory and the finished payload is moved
into InstallRoot with a same-volume atomic directory rename.

The -AdoptVerifiedRuntime mode performs no network request. It requires both
pinned runtime archives to already exist in CacheRoot, each under its exact
manifest filename with either no suffix or a .partial suffix. It reconstructs
the expected runtime in an owned staging directory and adds a receipt only when
the existing runtime has an identical, reparse-free file and directory tree.

Model GGUF and mmproj files remain optional except for models explicitly named
with -DownloadModels. Requested pairs download from immutable Hugging Face
revisions into resumable .partial files and are accepted only after exact byte
length and SHA-256 verification. Existing verified files are reused. Pass
-VerifyManualModels to check every model file already present in ModelRoot.

.EXAMPLE
.\install_heretic_llamacpp.ps1

.EXAMPLE
.\install_heretic_llamacpp.ps1 -VerifyManualModels

.EXAMPLE
.\install_heretic_llamacpp.ps1 -DownloadModels 8B -VerifyManualModels

.EXAMPLE
.\install_heretic_llamacpp.ps1 -InstallRoot 'D:\Krea2Vision\llama.cpp\b10590' -CacheRoot 'D:\Krea2Vision\downloads'

.EXAMPLE
.\install_heretic_llamacpp.ps1 -AdoptVerifiedRuntime -InstallRoot "$env:LOCALAPPDATA\Krea2Vision\llama.cpp\b10590" -CacheRoot "$env:LOCALAPPDATA\Krea2VisionSuite\models\.downloads"
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [Parameter()]
    [string] $ManifestPath,

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $InstallRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Krea2Vision\llama.cpp\b10590'),

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $CacheRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Krea2VisionSuite\models\.downloads'),

    [Parameter()]
    [ValidateNotNullOrEmpty()]
    [string] $ModelRoot = (Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Krea2VisionSuite\models'),

    [Parameter()]
    [string] $ModelReadmeTemplatePath,

    [Parameter()]
    [switch] $VerifyManualModels,

    [Parameter()]
    [ValidateSet('2B','4B','8B','9B-GLM-Abliterated','12B-Opus','12B-Heretic','26B-A4B-Heretic','30B-A3B-Abliterated','31B','32B')]
    [string[]] $DownloadModels = @(),

    [Parameter()]
    [switch] $AdoptVerifiedRuntime
)

Set-StrictMode -Version 3.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:ReceiptFileName = '.krea2-llamacpp-install-receipt.json'
$script:StagePrefix = '.krea2-stage-llamacpp-'
$script:ExpectedBundleId = 'krea2-vision-heretic-llamacpp-b10590'

if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $PSScriptRoot 'heretic_llamacpp_artifacts.json'
}
if ([string]::IsNullOrWhiteSpace($ModelReadmeTemplatePath)) {
    $ModelReadmeTemplatePath = Join-Path $PSScriptRoot 'README-KREA-HERETIC-MODELS.txt'
}

function Get-NormalizedPath {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'A filesystem path was empty.'
    }

    $expanded = [Environment]::ExpandEnvironmentVariables($Path)
    $full = [IO.Path]::GetFullPath($expanded)
    $root = [IO.Path]::GetPathRoot($full)

    while (($full.Length -gt $root.Length) -and
        (($full.EndsWith([string][IO.Path]::DirectorySeparatorChar)) -or
         ($full.EndsWith([string][IO.Path]::AltDirectorySeparatorChar)))) {
        $full = $full.Substring(0, $full.Length - 1)
    }

    return $full
}

function Test-SameOrChildPath {
    param(
        [Parameter(Mandatory = $true)]
        [string] $ParentPath,

        [Parameter(Mandatory = $true)]
        [string] $CandidatePath
    )

    $parent = Get-NormalizedPath -Path $ParentPath
    $candidate = Get-NormalizedPath -Path $CandidatePath
    if ($candidate.Equals($parent, [StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }

    $prefix = $parent + [IO.Path]::DirectorySeparatorChar
    return $candidate.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeWritableRoot {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path,

        [Parameter(Mandatory = $true)]
        [string] $Label
    )

    $full = Get-NormalizedPath -Path $Path
    $volumeRoot = [IO.Path]::GetPathRoot($full)
    if ($full.Equals($volumeRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('{0} cannot be a filesystem root: {1}' -f $Label, $full)
    }

    if ((Test-Path -LiteralPath $full) -and -not (Test-Path -LiteralPath $full -PathType Container)) {
        throw ('{0} is an existing file, not a directory: {1}' -f $Label, $full)
    }

    return $full
}

function Assert-RootsDoNotOverlap {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FirstPath,

        [Parameter(Mandatory = $true)]
        [string] $FirstLabel,

        [Parameter(Mandatory = $true)]
        [string] $SecondPath,

        [Parameter(Mandatory = $true)]
        [string] $SecondLabel
    )

    if ((Test-SameOrChildPath -ParentPath $FirstPath -CandidatePath $SecondPath) -or
        (Test-SameOrChildPath -ParentPath $SecondPath -CandidatePath $FirstPath)) {
        throw ('{0} and {1} must be separate, non-nested directories.' -f $FirstLabel, $SecondLabel)
    }
}

function Get-SafeChildPath {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Root,

        [Parameter(Mandatory = $true)]
        [string] $RelativePath
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [IO.Path]::IsPathRooted($RelativePath)) {
        throw ('Unsafe relative path: {0}' -f $RelativePath)
    }

    $rootFull = Get-NormalizedPath -Path $Root
    $nativeRelative = $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $candidate = [IO.Path]::GetFullPath((Join-Path $rootFull $nativeRelative))
    $requiredPrefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $candidate.StartsWith($requiredPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('Relative path escapes its root: {0}' -f $RelativePath)
    }

    return $candidate
}

function Get-PortableRelativePath {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Root,

        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $rootFull = Get-NormalizedPath -Path $Root
    $pathFull = Get-NormalizedPath -Path $Path
    $prefix = $rootFull + [IO.Path]::DirectorySeparatorChar
    if (-not $pathFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw ('Path is outside the expected root: {0}' -f $pathFull)
    }

    return $pathFull.Substring($prefix.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')
}

function Get-Sha256 {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $stream = $null
    $hasher = $null
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $hasher = [Security.Cryptography.SHA256]::Create()
        $hashBytes = $hasher.ComputeHash($stream)
        return ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        if ($null -ne $hasher) {
            $hasher.Dispose()
        }
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }
}

function Assert-ObjectProperties {
    param(
        [Parameter(Mandatory = $true)]
        [object] $InputObject,

        [Parameter(Mandatory = $true)]
        [string[]] $Names,

        [Parameter(Mandatory = $true)]
        [string] $Label
    )

    if ($null -eq $InputObject) {
        throw ('Missing object: {0}' -f $Label)
    }

    $available = @($InputObject.PSObject.Properties.Name)
    foreach ($name in $Names) {
        if ($available -notcontains $name) {
            throw ('{0} is missing required property "{1}".' -f $Label, $name)
        }
    }
}

function ConvertTo-ValidatedArtifact {
    param(
        [Parameter(Mandatory = $true)]
        [object] $InputObject,

        [Parameter(Mandatory = $true)]
        [string] $Label,

        [Parameter()]
        [AllowNull()]
        [string] $ExpectedRelativeDirectory,

        [Parameter()]
        [AllowNull()]
        [string] $ExpectedUrl
    )

    Assert-ObjectProperties -InputObject $InputObject -Names @('id', 'file_name', 'url', 'bytes', 'sha256') -Label $Label

    $id = [string]$InputObject.id
    $fileName = [string]$InputObject.file_name
    $url = [string]$InputObject.url
    $sha256 = ([string]$InputObject.sha256).ToLowerInvariant()
    [long]$bytes = 0

    if ($id -notmatch '^[a-z0-9][a-z0-9-]{2,79}$') {
        throw ('{0} has an unsafe artifact id: {1}' -f $Label, $id)
    }

    if ([string]::IsNullOrWhiteSpace($fileName) -or
        ([IO.Path]::GetFileName($fileName) -ne $fileName) -or
        ($fileName.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0)) {
        throw ('{0} has an unsafe file name: {1}' -f $Label, $fileName)
    }

    if (-not [long]::TryParse([string]$InputObject.bytes, [ref]$bytes) -or $bytes -le 0) {
        throw ('{0} has an invalid byte length.' -f $Label)
    }

    if ($sha256 -notmatch '^[0-9a-f]{64}$') {
        throw ('{0} has an invalid SHA-256.' -f $Label)
    }

    $uri = $null
    if (-not [Uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -or $uri.Scheme -ne 'https') {
        throw ('{0} must use an absolute HTTPS URL.' -f $Label)
    }

    if ($PSBoundParameters.ContainsKey('ExpectedUrl') -and -not $url.Equals($ExpectedUrl, [StringComparison]::Ordinal)) {
        throw ('{0} does not match its pinned URL.' -f $Label)
    }

    $relativePath = $null
    if ($PSBoundParameters.ContainsKey('ExpectedRelativeDirectory')) {
        Assert-ObjectProperties -InputObject $InputObject -Names @('relative_path') -Label $Label
        $relativePath = ([string]$InputObject.relative_path).Replace('\', '/')
        $expectedRelativePath = $ExpectedRelativeDirectory + '/' + $fileName
        if (-not $relativePath.Equals($expectedRelativePath, [StringComparison]::Ordinal)) {
            throw ('{0} must use relative_path "{1}".' -f $Label, $expectedRelativePath)
        }
    }

    $variant = $null
    if (@($InputObject.PSObject.Properties.Name) -contains 'variant') {
        $variant = [string]$InputObject.variant
    }

    return [pscustomobject]@{
        Id = $id
        FileName = $fileName
        RelativePath = $relativePath
        Url = $url
        Bytes = $bytes
        Sha256 = $sha256
        Variant = $variant
    }
}

function Read-ArtifactManifest {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    $manifestFull = Get-NormalizedPath -Path $Path
    if (-not (Test-Path -LiteralPath $manifestFull -PathType Leaf)) {
        throw ('Artifact manifest was not found: {0}' -f $manifestFull)
    }

    $manifestItem = Get-Item -LiteralPath $manifestFull
    if ($manifestItem.Length -gt 1048576) {
        throw 'Artifact manifest is unexpectedly large.'
    }

    try {
        $manifest = Get-Content -LiteralPath $manifestFull -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw ('Artifact manifest is not valid JSON: {0}' -f $_.Exception.Message)
    }

    Assert-ObjectProperties -InputObject $manifest -Names @('version', 'bundle_id', 'llama_cpp', 'model_installation', 'models') -Label 'manifest'
    if ([int]$manifest.version -ne 1) {
        throw ('Unsupported artifact manifest version: {0}' -f $manifest.version)
    }
    if ([string]$manifest.bundle_id -ne $script:ExpectedBundleId) {
        throw ('Unexpected bundle_id: {0}' -f $manifest.bundle_id)
    }

    Assert-ObjectProperties -InputObject $manifest.llama_cpp -Names @(
        'repository', 'release_id', 'release_tag', 'target_commit', 'published_utc',
        'release_url', 'platform', 'cuda_version', 'required_executable', 'assets'
    ) -Label 'llama_cpp'

    $publishedUtc = if ($manifest.llama_cpp.published_utc -is [DateTime]) {
        $manifest.llama_cpp.published_utc.ToUniversalTime().ToString(
            'yyyy-MM-ddTHH:mm:ssZ',
            [Globalization.CultureInfo]::InvariantCulture
        )
    }
    else {
        [string]$manifest.llama_cpp.published_utc
    }

    if ([string]$manifest.llama_cpp.repository -ne 'ggml-org/llama.cpp' -or
        [long]$manifest.llama_cpp.release_id -ne 375153983 -or
        [string]$manifest.llama_cpp.release_tag -ne 'b10590' -or
        [string]$manifest.llama_cpp.target_commit -ne '6657ded4faa3b8450221119fc6b4d002e35104a2' -or
        $publishedUtc -ne '2026-08-23T08:20:51Z' -or
        [string]$manifest.llama_cpp.release_url -ne 'https://github.com/ggml-org/llama.cpp/releases/tag/b10590' -or
        [string]$manifest.llama_cpp.platform -ne 'windows-x64' -or
        [string]$manifest.llama_cpp.cuda_version -ne '13.3' -or
        [string]$manifest.llama_cpp.required_executable -ne 'llama-server.exe') {
        throw 'The llama.cpp release metadata does not match the reviewed b10590 Windows CUDA 13.3 release.'
    }

    $runtimeExpected = @{
        'llama-cpp-runtime' = [pscustomobject]@{
            FileName = 'llama-b10590-bin-win-cuda-13.3-x64.zip'
            Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b10590/llama-b10590-bin-win-cuda-13.3-x64.zip'
            Bytes = [long]146492424
            Sha256 = '22b9ce3524c0d82afd1ad6077268d6429d92d59d16638d3be28ecac8fcaa5a8e'
        }
        'llama-cpp-cuda-runtime' = [pscustomobject]@{
            FileName = 'cudart-llama-bin-win-cuda-13.3-x64.zip'
            Url = 'https://github.com/ggml-org/llama.cpp/releases/download/b10590/cudart-llama-bin-win-cuda-13.3-x64.zip'
            Bytes = [long]390970417
            Sha256 = '1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e'
        }
    }

    $runtimeInput = @($manifest.llama_cpp.assets)
    if ($runtimeInput.Count -ne 2) {
        throw 'The manifest must contain exactly two llama.cpp runtime assets.'
    }

    $allIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $runtimeArtifacts = @()
    foreach ($asset in $runtimeInput) {
        $assetId = [string]$asset.id
        if (-not $runtimeExpected.ContainsKey($assetId)) {
            throw ('Unexpected runtime artifact id: {0}' -f $assetId)
        }

        $expected = $runtimeExpected[$assetId]
        $validated = ConvertTo-ValidatedArtifact -InputObject $asset -Label ('runtime asset {0}' -f $assetId) -ExpectedUrl $expected.Url
        if ($validated.FileName -ne $expected.FileName -or
            $validated.Bytes -ne $expected.Bytes -or
            $validated.Sha256 -ne $expected.Sha256) {
            throw ('Runtime artifact {0} does not match the reviewed release asset.' -f $assetId)
        }
        if (-not $allIds.Add($validated.Id)) {
            throw ('Duplicate artifact id: {0}' -f $validated.Id)
        }
        $runtimeArtifacts += $validated
    }

    Assert-ObjectProperties -InputObject $manifest.model_installation -Names @(
        'mode', 'default_download', 'default_root', 'required_model_quant', 'mmproj_policy', 'mmproj_preference'
    ) -Label 'model_installation'
    if ([string]$manifest.model_installation.mode -ne 'recommended_auto_optional' -or
        [string]$manifest.model_installation.default_download -ne '8B' -or
        [string]$manifest.model_installation.required_model_quant -ne '2B:F16;4B:Q8_0;8B:Q8_0;9B-GLM:Q5_K_M;12B-Opus:Q8_0;12B-Heretic:Q8_0;26B-A4B:Q3_K_L;30B-A3B:Q2_K;31B:Q4_K_M;32B:Q4_K_M' -or
        [string]$manifest.model_installation.mmproj_policy -ne 'per_model_pinned') {
        throw 'The model installation policy must remain the reviewed ten-model exact body/projector set.'
    }
    if ([string]$manifest.model_installation.default_root -ne '%LOCALAPPDATA%\Krea2VisionSuite\models') {
        throw 'The manifest model root is not the reviewed suite models folder.'
    }
    $projectorPreference = @($manifest.model_installation.mmproj_preference)
    if ($projectorPreference.Count -ne 2 -or
        [string]$projectorPreference[0] -ne 'Q8_0' -or
        [string]$projectorPreference[1] -ne 'BF16') {
        throw 'The projector policy must contain the reviewed Q8_0 and BF16 variants.'
    }

    $expectedModels = @{
        'qwen3-vl-heretic-2b-f16' = [pscustomobject]@{
            ParameterSize = '2B'
            Directory = '2B'
            Repository = 'mradermacher/Qwen-3-VL-2B-Instruct-heretic-GGUF'
            Revision = 'ef376dc99d248134d412ad5b84039c81a3d9a01e'
            ModelFileName = 'Qwen-3-VL-2B-Instruct-heretic.f16.gguf'
            ModelBytes = [long]3447351232
            ModelSha256 = 'd8ba23ece883c84dd9b2e629bad36d37ef60f10d139d523d584f216e71168188'
            ProjectorFileName = 'Qwen-3-VL-2B-Instruct-heretic.mmproj-Q8_0.gguf'
            ProjectorBytes = [long]445053696
            ProjectorSha256 = 'b976865c9328f6af55f41e81d731338a3f2e0b1976a3dd51db836949aa7f8ed1'
            ProjectorRepository = 'mradermacher/Qwen-3-VL-2B-Instruct-heretic-GGUF'
            ProjectorRevision = 'ef376dc99d248134d412ad5b84039c81a3d9a01e'
            ProjectorVariant = 'Q8_0'
        }
        'qwen3-vl-heretic-4b-q8-0' = [pscustomobject]@{
            ParameterSize = '4B'
            Directory = '4B'
            Repository = 'mradermacher/Qwen3-VL-4B-Instruct-heretic-GGUF'
            Revision = 'fc66f488427738c8a4ed90a9a3e2c959ea86b0b9'
            ModelFileName = 'Qwen3-VL-4B-Instruct-heretic.Q8_0.gguf'
            ModelBytes = [long]4280407104
            ModelSha256 = '029234e925c6517041c47d6e67f175f4f9dc067941f42b1c695a60d7fb31854f'
            ProjectorFileName = 'Qwen3-VL-4B-Instruct-heretic.mmproj-Q8_0.gguf'
            ProjectorBytes = [long]453974752
            ProjectorSha256 = '95a4eecc6288ba04694fada64d2c2b0552ae3f641aaffc0510b69ac6fe54cf81'
            ProjectorRepository = 'mradermacher/Qwen3-VL-4B-Instruct-heretic-GGUF'
            ProjectorRevision = 'fc66f488427738c8a4ed90a9a3e2c959ea86b0b9'
            ProjectorVariant = 'Q8_0'
        }
        'qwen3-vl-heretic-8b-q8-0' = [pscustomobject]@{
            ParameterSize = '8B'
            Directory = '8B'
            Repository = 'mradermacher/Qwen-3-VL-8B-Instruct-heretic-GGUF'
            Revision = 'ee9e0de47684c84abba6e420f5f89625813a08f4'
            ModelFileName = 'Qwen-3-VL-8B-Instruct-heretic.Q8_0.gguf'
            ModelBytes = [long]8709520480
            ModelSha256 = '32f6e3b5b119ffae94a1afa38e72da17fbd4c5f31a62e3594543b71e89c7a0ea'
            ProjectorFileName = 'Qwen-3-VL-8B-Instruct-heretic.mmproj-Q8_0.gguf'
            ProjectorBytes = [long]752290304
            ProjectorSha256 = 'ac58c05e3bdc30b33d4e5e642c76cc305f298b0564900ab930e069662a3e8293'
            ProjectorRepository = 'mradermacher/Qwen-3-VL-8B-Instruct-heretic-GGUF'
            ProjectorRevision = 'ee9e0de47684c84abba6e420f5f89625813a08f4'
            ProjectorVariant = 'Q8_0'
        }
        'glm4-9b-abliterated-q5-k-m' = [pscustomobject]@{
            ParameterSize = '9B'
            Directory = '9B-GLM-Abliterated'
            Repository = 'AliBilge/Huihui-GLM-4.6V-Flash-abliterated'
            Revision = 'a59894e6bca5a86d601faf654587d1353f5f8f0f'
            ModelFileName = 'Huihui-GLM-4.6V-Flash-abliterated-Q5_K_M.gguf'
            ModelBytes = [long]7050921024
            ModelSha256 = '39f5fb7fdbfc6b761a9531fa1d047356c44775b3ca9db7a3f3da5079f54ea0f5'
            ProjectorFileName = 'Huihui-GLM-4.6V-Flash-abliterated.mmproj-Q8_0.gguf'
            ProjectorBytes = [long]1030387776
            ProjectorSha256 = '5c28edff1192bbfcce3e57e6df44d2a3320708d592d6089778fa66187e46b8b0'
            ProjectorRepository = 'mradermacher/Huihui-GLM-4.6V-Flash-abliterated-GGUF'
            ProjectorRevision = '9360ea4a6160764032619ef680d34ef4620961e9'
            ProjectorVariant = 'Q8_0'
        }
        'gemma4-12b-opus-uncensored-q8-0' = [pscustomobject]@{
            ParameterSize = '12B'
            Directory = '12B-Opus'
            Repository = 'Rangle2/gemma-4-12B-it-uncensored-opus4.7-cot'
            Revision = '5b87c4f821f79d0b2a9bbf4ccbb3d260f302517a'
            ModelFileName = 'gemma-4-12B-it-uncensored-opus4.7-cot-Q8_0.gguf'
            ModelBytes = [long]12669645824
            ModelSha256 = '1f75e15fe81dee8161a21bbb12b18161b11be79d58884d6813cd573f777b0662'
            ProjectorFileName = 'mmproj-gemma-4-12B-it-Q8_0.gguf'
            ProjectorBytes = [long]158987616
            ProjectorSha256 = '59e62255435dda870e2d1de97cc031330b31a898bac12b38a182cecff9cd3738'
            ProjectorRepository = 'ggml-org/gemma-4-12B-it-GGUF'
            ProjectorRevision = 'e3e681731089efaa3f0917336944ac64752db8ba'
            ProjectorVariant = 'Q8_0'
        }
        'gemma4-12b-heretic-q8-0' = [pscustomobject]@{
            ParameterSize = '12B'
            Directory = '12B-Heretic'
            Repository = 'llmfan46/gemma-4-12B-it-uncensored-heretic-GGUF'
            Revision = 'e169171d3f2d19734afc1fb6521daa4da1c0a5bd'
            ModelFileName = 'gemma-4-12B-it-uncensored-heretic-Q8_0.gguf'
            ModelBytes = [long]12669649056
            ModelSha256 = 'a88061c9442e12aff20b670b1909acdd3c0939add274a1fc8fabf889cdc9b481'
            ProjectorFileName = 'gemma-4-12B-it-uncensored-heretic-mmproj-BF16.gguf'
            ProjectorBytes = [long]175115328
            ProjectorSha256 = '260bf379fb313557642b51f55699530cf76d3b76555ca84b7ac7434873512cef'
            ProjectorRepository = 'llmfan46/gemma-4-12B-it-uncensored-heretic-GGUF'
            ProjectorRevision = 'e169171d3f2d19734afc1fb6521daa4da1c0a5bd'
            ProjectorVariant = 'BF16'
        }
        'gemma4-26b-a4b-heretic-q3-k-l' = [pscustomobject]@{
            ParameterSize = '26B-A4B'
            Directory = '26B-A4B-Heretic'
            Repository = 'llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF'
            Revision = 'ea0259bf66bcd33b5f3425eb223932abaa0f4f07'
            ModelFileName = 'gemma-4-26B-A4B-it-uncensored-heretic-Q3_K_L.gguf'
            ModelBytes = [long]13824487424
            ModelSha256 = '431a5dd46d69d996d5a682d44dadcdd87cad3834185cbaea4176484151974b92'
            ProjectorFileName = 'gemma-4-26B-A4B-it-mmproj-BF16.gguf'
            ProjectorBytes = [long]1194828000
            ProjectorSha256 = 'b3ee6c97d5a5bb1ae9eb93bf14c1d1b51a0179a45ac1076b195931814c759e1e'
            ProjectorRepository = 'llmfan46/gemma-4-26B-A4B-it-uncensored-heretic-GGUF'
            ProjectorRevision = 'ea0259bf66bcd33b5f3425eb223932abaa0f4f07'
            ProjectorVariant = 'BF16'
        }
        'qwen3-vl-30b-a3b-abliterated-q2-k' = [pscustomobject]@{
            ParameterSize = '30B-A3B'
            Directory = '30B-A3B-Abliterated'
            Repository = 'mradermacher/Qwen3-VL-30B-A3B-Instruct-abliterated-GGUF'
            Revision = '06c53e7f17a17f3614ace0c5fcceceedd673e582'
            ModelFileName = 'Qwen3-VL-30B-A3B-Instruct-abliterated.Q2_K.gguf'
            ModelBytes = [long]11258611520
            ModelSha256 = 'f2ce98665d6afac451fa862a7c5d5cbeb16be57e5699d6a1f0c0dc245f4bdbc6'
            ProjectorFileName = 'Qwen3-VL-30B-A3B-Instruct-abliterated.mmproj-Q8_0.gguf'
            ProjectorBytes = [long]712149440
            ProjectorSha256 = 'fe92d9e473662224403e6f7e7446949fb4740f079b8b9765c0896adaf1a23615'
            ProjectorRepository = 'mradermacher/Qwen3-VL-30B-A3B-Instruct-abliterated-GGUF'
            ProjectorRevision = '06c53e7f17a17f3614ace0c5fcceceedd673e582'
            ProjectorVariant = 'Q8_0'
        }
        'gemma4-31b-heretic-q4-k-m' = [pscustomobject]@{
            ParameterSize = '31B'
            Directory = '31B'
            Repository = 'llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF'
            Revision = 'eee61b81461ac75eb920a24ca9e5d420bb66e33d'
            ModelFileName = 'gemma-4-31B-it-uncensored-heretic-Q4_K_M.gguf'
            ModelBytes = [long]18687063168
            ModelSha256 = '7c65a35e7c4e53cba6c5e02cc9eeb850eb4251f4d9ad120c2caa6de23c5a6395'
            ProjectorFileName = 'gemma-4-31B-it-mmproj-BF16.gguf'
            ProjectorBytes = [long]1200726208
            ProjectorSha256 = '21487ff26d08f7ddd1d654d3bbfc1ae1020aab3119f5bf654742ce4697732e4e'
            ProjectorRepository = 'llmfan46/gemma-4-31B-it-uncensored-heretic-GGUF'
            ProjectorRevision = 'eee61b81461ac75eb920a24ca9e5d420bb66e33d'
            ProjectorVariant = 'BF16'
        }
        'qwen3-vl-32b-heretic-q4-k-m' = [pscustomobject]@{
            ParameterSize = '32B'
            Directory = '32B'
            Repository = 'llmfan46/Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-GGUF'
            Revision = '1d2008adce22f0b1793be2d7b8cc960c0264d149'
            ModelFileName = 'Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-Q4_K_M.gguf'
            ModelBytes = [long]19783121952
            ModelSha256 = 'a2e020522bdef80890e9504cce208087751652e79896504efb0f349611c05dd3'
            ProjectorFileName = 'Qwen3-VL-32B-Instruct-mmproj-BF16.gguf'
            ProjectorBytes = [long]1200334112
            ProjectorSha256 = '704973267ed68dc7d2316fb56aeaa4127679171725c2b6b196c2ab7c09fdf4c7'
            ProjectorRepository = 'llmfan46/Qwen3-VL-32B-Instruct-ultra-uncensored-heretic-GGUF'
            ProjectorRevision = '1d2008adce22f0b1793be2d7b8cc960c0264d149'
            ProjectorVariant = 'BF16'
        }
    }

    $modelInput = @($manifest.models)
    if ($modelInput.Count -ne 10) {
        throw 'The manifest must contain exactly the ten reviewed model records.'
    }

    $validatedModels = @()
    $seenModelPublicIds = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($model in $modelInput) {
        Assert-ObjectProperties -InputObject $model -Names @(
            'public_id', 'parameter_size', 'directory', 'repository', 'revision', 'model', 'mmproj'
        ) -Label 'model record'

        $publicId = [string]$model.public_id
        if (-not $expectedModels.ContainsKey($publicId)) {
            throw ('Unexpected model public_id: {0}' -f $publicId)
        }
        if (-not $seenModelPublicIds.Add($publicId)) {
            throw ('Duplicate model public_id: {0}' -f $publicId)
        }
        $expectedModel = $expectedModels[$publicId]
        if ([string]$model.parameter_size -ne $expectedModel.ParameterSize -or
            [string]$model.directory -ne $expectedModel.Directory -or
            [string]$model.repository -ne $expectedModel.Repository -or
            [string]$model.revision -ne $expectedModel.Revision) {
            throw ('Model metadata does not match the pinned record for {0}.' -f $publicId)
        }

        $modelFile = ConvertTo-ValidatedArtifact -InputObject $model.model -Label ('model file for {0}' -f $publicId) -ExpectedRelativeDirectory $expectedModel.Directory
        $expectedModelUrl = 'https://huggingface.co/{0}/resolve/{1}/{2}?download=true' -f $expectedModel.Repository, $expectedModel.Revision, $modelFile.FileName
        if ($modelFile.Url -ne $expectedModelUrl -or
            $modelFile.FileName -ne $expectedModel.ModelFileName -or
            $modelFile.Bytes -ne $expectedModel.ModelBytes -or
            $modelFile.Sha256 -ne $expectedModel.ModelSha256) {
            throw ('The model artifact for {0} is not the reviewed quant-specific file.' -f $publicId)
        }
        if (-not $allIds.Add($modelFile.Id)) {
            throw ('Duplicate artifact id: {0}' -f $modelFile.Id)
        }

        $projectorInput = @($model.mmproj)
        if ($projectorInput.Count -ne 1) {
            throw ('Model {0} must declare exactly one pinned projector.' -f $publicId)
        }

        $projectors = @()
        foreach ($projector in $projectorInput) {
            $validatedProjector = ConvertTo-ValidatedArtifact -InputObject $projector -Label ('projector for {0}' -f $publicId) -ExpectedRelativeDirectory $expectedModel.Directory
            if ($validatedProjector.Variant -ne $expectedModel.ProjectorVariant) {
                throw ('Model {0} contains an unsupported projector variant.' -f $publicId)
            }
            $expectedProjectorUrl = 'https://huggingface.co/{0}/resolve/{1}/{2}?download=true' -f $expectedModel.ProjectorRepository, $expectedModel.ProjectorRevision, $validatedProjector.FileName
            if ($validatedProjector.Url -ne $expectedProjectorUrl -or
                $validatedProjector.FileName -ne $expectedModel.ProjectorFileName -or
                $validatedProjector.Bytes -ne $expectedModel.ProjectorBytes -or
                $validatedProjector.Sha256 -ne $expectedModel.ProjectorSha256) {
                throw ('Projector URL is not pinned to the immutable revision for {0}.' -f $publicId)
            }
            if ($validatedProjector.Variant -eq 'Q8_0' -and $validatedProjector.FileName -notmatch '\.mmproj-Q8_0\.gguf$') {
                if ($validatedProjector.FileName -notmatch '^mmproj-.+-Q8_0\.gguf$') {
                    throw ('Q8_0 projector filename mismatch for {0}.' -f $publicId)
                }
            }
            if (-not $allIds.Add($validatedProjector.Id)) {
                throw ('Duplicate artifact id: {0}' -f $validatedProjector.Id)
            }
            $projectors += $validatedProjector
        }

        $variants = @($projectors | ForEach-Object { $_.Variant } | Sort-Object -Unique)
        if ($variants.Count -ne 1 -or $variants[0] -ne $expectedModel.ProjectorVariant) {
            throw ('Model {0} does not contain exactly its reviewed projector variant.' -f $publicId)
        }

        $validatedModels += [pscustomobject]@{
            PublicId = $publicId
            ParameterSize = $expectedModel.ParameterSize
            Directory = $expectedModel.Directory
            Model = $modelFile
            Projectors = @($projectors)
        }
    }

    foreach ($expectedPublicId in @($expectedModels.Keys)) {
        if (-not $seenModelPublicIds.Contains($expectedPublicId)) {
            throw ('The manifest is missing the required model public_id: {0}' -f $expectedPublicId)
        }
    }

    return [pscustomobject]@{
        Path = $manifestFull
        Sha256 = Get-Sha256 -Path $manifestFull
        Manifest = $manifest
        RuntimeArtifacts = @($runtimeArtifacts)
        Models = @($validatedModels)
    }
}

function Test-ArtifactFile {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path,

        [Parameter(Mandatory = $true)]
        [long] $ExpectedBytes,

        [Parameter(Mandatory = $true)]
        [string] $ExpectedSha256
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $false
    }

    $item = Get-Item -LiteralPath $Path
    if ($item.Length -ne $ExpectedBytes) {
        return $false
    }

    return (Get-Sha256 -Path $Path) -eq $ExpectedSha256
}

function Move-InvalidDownloadAside {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Path
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw ('Download cache path is not a file: {0}' -f $Path)
    }

    $suffix = '.invalid.{0}.{1}' -f ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')), ([Guid]::NewGuid().ToString('N'))
    $destination = $Path + $suffix
    [IO.File]::Move($Path, $destination)
    Write-Warning ('Moved an invalid cached file aside: {0}' -f $destination)
}

function New-DownloadClient {
    Add-Type -AssemblyName System.Net.Http

    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $true
    $handler.MaxAutomaticRedirections = 10
    $handler.AutomaticDecompression = [Net.DecompressionMethods]::None

    $client = New-Object System.Net.Http.HttpClient($handler, $true)
    $client.Timeout = [TimeSpan]::FromHours(24)
    $null = $client.DefaultRequestHeaders.UserAgent.ParseAdd('Krea2VisionRuntimeInstaller/1.0')
    return $client
}

function Get-VerifiedArtifact {
    param(
        [Parameter(Mandatory = $true)]
        [object] $Artifact,

        [Parameter(Mandatory = $true)]
        [string] $DestinationRoot,

        [Parameter(Mandatory = $true)]
        [System.Net.Http.HttpClient] $Client
    )

    [IO.Directory]::CreateDirectory($DestinationRoot) | Out-Null
    $finalPath = Get-SafeChildPath -Root $DestinationRoot -RelativePath $Artifact.FileName
    $partialPath = $finalPath + '.partial'

    if (Test-ArtifactFile -Path $finalPath -ExpectedBytes $Artifact.Bytes -ExpectedSha256 $Artifact.Sha256) {
        Write-Host ('Using verified artifact: {0}' -f $finalPath)
        return $finalPath
    }
    if (Test-Path -LiteralPath $finalPath) {
        Move-InvalidDownloadAside -Path $finalPath
    }

    [long]$resumeOffset = 0
    if (Test-Path -LiteralPath $partialPath) {
        if (-not (Test-Path -LiteralPath $partialPath -PathType Leaf)) {
            throw ('Partial download path is not a file: {0}' -f $partialPath)
        }

        $partialLength = (Get-Item -LiteralPath $partialPath).Length
        if ($partialLength -gt $Artifact.Bytes) {
            Move-InvalidDownloadAside -Path $partialPath
        }
        elseif ($partialLength -eq $Artifact.Bytes) {
            if (Test-ArtifactFile -Path $partialPath -ExpectedBytes $Artifact.Bytes -ExpectedSha256 $Artifact.Sha256) {
                [IO.File]::Move($partialPath, $finalPath)
                Write-Host ('Completed verified artifact: {0}' -f $finalPath)
                return $finalPath
            }
            Move-InvalidDownloadAside -Path $partialPath
        }
        else {
            $resumeOffset = $partialLength
        }
    }

    $request = New-Object System.Net.Http.HttpRequestMessage([System.Net.Http.HttpMethod]::Get, $Artifact.Url)
    if ($resumeOffset -gt 0) {
        $null = $request.Headers.TryAddWithoutValidation('Range', ('bytes={0}-' -f $resumeOffset))
        Write-Host ('Resuming {0} at byte {1:N0} of {2:N0}.' -f $Artifact.FileName, $resumeOffset, $Artifact.Bytes)
    }
    else {
        Write-Host ('Downloading {0} ({1:N0} bytes).' -f $Artifact.FileName, $Artifact.Bytes)
    }

    $response = $null
    try {
        $response = $Client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $statusCode = [int]$response.StatusCode
        if ($statusCode -ne 200 -and $statusCode -ne 206) {
            throw ('Download failed for {0}: HTTP {1} ({2}).' -f $Artifact.FileName, $statusCode, $response.ReasonPhrase)
        }

        [long]$writeOffset = $resumeOffset
        $fileMode = [IO.FileMode]::Append
        if ($statusCode -eq 206) {
            $contentRange = $response.Content.Headers.ContentRange
            if ($null -eq $contentRange -or
                $null -eq $contentRange.From -or
                [long]$contentRange.From -ne $resumeOffset -or
                $null -eq $contentRange.Length -or
                [long]$contentRange.Length -ne $Artifact.Bytes) {
                throw ('Server returned an unsafe Content-Range for {0}.' -f $Artifact.FileName)
            }
        }
        else {
            if ($resumeOffset -gt 0) {
                Write-Warning ('Server ignored the Range request for {0}; restarting that partial download.' -f $Artifact.FileName)
                Move-InvalidDownloadAside -Path $partialPath
            }
            $writeOffset = 0
            $fileMode = [IO.FileMode]::Create
        }

        $contentLength = $response.Content.Headers.ContentLength
        if ($null -ne $contentLength -and [long]$contentLength -ne ($Artifact.Bytes - $writeOffset)) {
            throw ('Unexpected HTTP Content-Length for {0}: expected {1}, received {2}.' -f $Artifact.FileName, ($Artifact.Bytes - $writeOffset), [long]$contentLength)
        }

        $networkStream = $null
        $fileStream = $null
        try {
            $networkStream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
            $fileStream = New-Object IO.FileStream($partialPath, $fileMode, [IO.FileAccess]::Write, [IO.FileShare]::None, 4194304, [IO.FileOptions]::SequentialScan)
            $buffer = New-Object byte[] 4194304
            [long]$writtenThisRequest = 0
            $lastReport = [DateTime]::UtcNow

            while ($true) {
                $read = $networkStream.Read($buffer, 0, $buffer.Length)
                if ($read -le 0) {
                    break
                }
                if (($writeOffset + $writtenThisRequest + $read) -gt $Artifact.Bytes) {
                    throw ('Server sent more bytes than declared for {0}.' -f $Artifact.FileName)
                }

                $fileStream.Write($buffer, 0, $read)
                $writtenThisRequest += $read
                if (([DateTime]::UtcNow - $lastReport).TotalSeconds -ge 15) {
                    Write-Host ('  {0:N0} / {1:N0} bytes' -f ($writeOffset + $writtenThisRequest), $Artifact.Bytes)
                    $lastReport = [DateTime]::UtcNow
                }
            }
            $fileStream.Flush($true)
        }
        finally {
            if ($null -ne $fileStream) {
                $fileStream.Dispose()
            }
            if ($null -ne $networkStream) {
                $networkStream.Dispose()
            }
        }
    }
    finally {
        if ($null -ne $response) {
            $response.Dispose()
        }
        $request.Dispose()
    }

    if (-not (Test-Path -LiteralPath $partialPath -PathType Leaf)) {
        throw ('Download ended without producing a partial file: {0}' -f $Artifact.FileName)
    }
    $receivedBytes = (Get-Item -LiteralPath $partialPath).Length
    if ($receivedBytes -ne $Artifact.Bytes) {
        throw ('Incomplete download retained for resume: {0} of {1} bytes for {2}.' -f $receivedBytes, $Artifact.Bytes, $Artifact.FileName)
    }

    $receivedHash = Get-Sha256 -Path $partialPath
    if ($receivedHash -ne $Artifact.Sha256) {
        Move-InvalidDownloadAside -Path $partialPath
        throw ('SHA-256 mismatch for {0}.' -f $Artifact.FileName)
    }

    if (Test-Path -LiteralPath $finalPath) {
        throw ('Verified cache destination appeared during download; refusing to overwrite it: {0}' -f $finalPath)
    }
    [IO.File]::Move($partialPath, $finalPath)
    Write-Host ('Verified artifact: {0}' -f $finalPath)
    return $finalPath
}

function Expand-VerifiedZipSafely {
    param(
        [Parameter(Mandatory = $true)]
        [string] $ArchivePath,

        [Parameter(Mandatory = $true)]
        [string] $DestinationPath
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    if (Test-Path -LiteralPath $DestinationPath) {
        throw ('ZIP expansion destination already exists: {0}' -f $DestinationPath)
    }
    [IO.Directory]::CreateDirectory($DestinationPath) | Out-Null

    $archiveStream = $null
    $archive = $null
    try {
        $archiveStream = New-Object IO.FileStream($ArchivePath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $archive = New-Object IO.Compression.ZipArchive($archiveStream, [IO.Compression.ZipArchiveMode]::Read, $false)

        foreach ($entry in $archive.Entries) {
            $entryName = [string]$entry.FullName
            if ([string]::IsNullOrWhiteSpace($entryName) -or
                $entryName.StartsWith('/') -or
                $entryName.StartsWith('\') -or
                $entryName.Contains(':') -or
                $entryName.Contains([char]0)) {
                throw ('Unsafe ZIP entry in {0}: {1}' -f $ArchivePath, $entryName)
            }

            $unixFileType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
            if ($unixFileType -eq 0xA000) {
                throw ('Symbolic links are not allowed in runtime ZIPs: {0}' -f $entryName)
            }

            $destination = Get-SafeChildPath -Root $DestinationPath -RelativePath $entryName
            $isDirectory = $entryName.EndsWith('/') -or [string]::IsNullOrEmpty($entry.Name)
            if ($isDirectory) {
                [IO.Directory]::CreateDirectory($destination) | Out-Null
                continue
            }

            $destinationDirectory = [IO.Path]::GetDirectoryName($destination)
            [IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
            if (Test-Path -LiteralPath $destination) {
                throw ('Duplicate ZIP entry destination: {0}' -f $entryName)
            }

            $entryStream = $null
            $outputStream = $null
            try {
                $entryStream = $entry.Open()
                $outputStream = New-Object IO.FileStream($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
                $entryStream.CopyTo($outputStream, 1048576)
                $outputStream.Flush($true)
            }
            finally {
                if ($null -ne $outputStream) {
                    $outputStream.Dispose()
                }
                if ($null -ne $entryStream) {
                    $entryStream.Dispose()
                }
            }
        }
    }
    finally {
        if ($null -ne $archive) {
            $archive.Dispose()
        }
        if ($null -ne $archiveStream) {
            $archiveStream.Dispose()
        }
    }
}

function Merge-DirectoryTree {
    param(
        [Parameter(Mandatory = $true)]
        [string] $SourceRoot,

        [Parameter(Mandatory = $true)]
        [string] $DestinationRoot
    )

    foreach ($item in @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -Force | Sort-Object FullName)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ('Reparse points are not allowed in the runtime payload: {0}' -f $item.FullName)
        }

        $relativePath = Get-PortableRelativePath -Root $SourceRoot -Path $item.FullName
        $destination = Get-SafeChildPath -Root $DestinationRoot -RelativePath $relativePath
        if ($item.PSIsContainer) {
            [IO.Directory]::CreateDirectory($destination) | Out-Null
            continue
        }

        $destinationDirectory = [IO.Path]::GetDirectoryName($destination)
        [IO.Directory]::CreateDirectory($destinationDirectory) | Out-Null
        if (Test-Path -LiteralPath $destination) {
            if (-not (Test-Path -LiteralPath $destination -PathType Leaf)) {
                throw ('Runtime archive collision is not a file: {0}' -f $relativePath)
            }
            $sourceItem = Get-Item -LiteralPath $item.FullName
            $destinationItem = Get-Item -LiteralPath $destination
            if ($sourceItem.Length -ne $destinationItem.Length -or
                (Get-Sha256 -Path $item.FullName) -ne (Get-Sha256 -Path $destination)) {
                throw ('Runtime archives contain conflicting files: {0}' -f $relativePath)
            }
            continue
        }

        [IO.File]::Copy($item.FullName, $destination, $false)
    }
}

function Assert-LlamaServerExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string] $RuntimeRoot
    )

    $serverPath = Get-SafeChildPath -Root $RuntimeRoot -RelativePath 'llama-server.exe'
    if (-not (Test-Path -LiteralPath $serverPath -PathType Leaf)) {
        throw ('The staged runtime does not contain llama-server.exe at its root: {0}' -f $serverPath)
    }
    if ((Get-Item -LiteralPath $serverPath).Length -lt 2) {
        throw 'The staged llama-server.exe is empty or truncated.'
    }

    $stream = $null
    try {
        $stream = New-Object IO.FileStream($serverPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $first = $stream.ReadByte()
        $second = $stream.ReadByte()
    }
    finally {
        if ($null -ne $stream) {
            $stream.Dispose()
        }
    }

    if ($first -ne 0x4D -or $second -ne 0x5A) {
        throw 'The staged llama-server.exe does not have a valid Windows PE signature.'
    }

    return $serverPath
}

function Assert-NoRuntimeReparsePoints {
    param(
        [Parameter(Mandatory = $true)]
        [string] $RuntimeRoot
    )

    $rootItem = Get-Item -LiteralPath $RuntimeRoot -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw ('Runtime root cannot be a reparse point: {0}' -f $rootItem.FullName)
    }

    foreach ($item in @(Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -Force)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw ('Reparse points are not allowed in the runtime tree: {0}' -f $item.FullName)
        }
    }
}

function Get-RuntimeDirectoryRecords {
    param(
        [Parameter(Mandatory = $true)]
        [string] $RuntimeRoot
    )

    Assert-NoRuntimeReparsePoints -RuntimeRoot $RuntimeRoot
    $records = @()
    foreach ($directory in @(Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -Force -Directory | Sort-Object FullName)) {
        $records += [pscustomobject]@{
            relative_path = Get-PortableRelativePath -Root $RuntimeRoot -Path $directory.FullName
        }
    }
    return @($records)
}

function Get-RuntimeFileRecords {
    param(
        [Parameter(Mandatory = $true)]
        [string] $RuntimeRoot
    )

    Assert-NoRuntimeReparsePoints -RuntimeRoot $RuntimeRoot
    $records = @()
    $receiptPath = Get-SafeChildPath -Root $RuntimeRoot -RelativePath $script:ReceiptFileName
    foreach ($file in @(Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -Force -File | Sort-Object FullName)) {
        if ($file.FullName.Equals($receiptPath, [StringComparison]::OrdinalIgnoreCase)) {
            continue
        }
        $records += [pscustomobject]@{
            relative_path = Get-PortableRelativePath -Root $RuntimeRoot -Path $file.FullName
            bytes = [long]$file.Length
            sha256 = Get-Sha256 -Path $file.FullName
        }
    }

    if ($records.Count -eq 0) {
        throw 'The staged runtime contains no files.'
    }
    return @($records)
}

function Write-RuntimeReceipt {
    param(
        [Parameter(Mandatory = $true)]
        [string] $RuntimeRoot,

        [Parameter(Mandatory = $true)]
        [string] $ManifestSha256,

        [Parameter(Mandatory = $true)]
        [object[]] $Artifacts
    )

    $sourceArtifacts = @($Artifacts | Sort-Object Id | ForEach-Object {
        [pscustomobject]@{
            id = $_.Id
            bytes = [long]$_.Bytes
            sha256 = $_.Sha256
        }
    })
    $directories = @(Get-RuntimeDirectoryRecords -RuntimeRoot $RuntimeRoot)
    $files = @(Get-RuntimeFileRecords -RuntimeRoot $RuntimeRoot)
    $receipt = [ordered]@{
        version = 1
        bundle_id = $script:ExpectedBundleId
        kind = 'llama.cpp-windows-cuda-runtime'
        release_tag = 'b10590'
        target_commit = '6657ded4faa3b8450221119fc6b4d002e35104a2'
        manifest_sha256 = $ManifestSha256
        source_artifacts = $sourceArtifacts
        directories = $directories
        files = $files
    }

    $receiptPath = Get-SafeChildPath -Root $RuntimeRoot -RelativePath $script:ReceiptFileName
    $partialPath = $receiptPath + '.partial.' + [Guid]::NewGuid().ToString('N')
    if (Test-Path -LiteralPath $receiptPath) {
        throw 'A receipt unexpectedly already exists in the runtime.'
    }

    try {
        $encoding = New-Object Text.UTF8Encoding($false)
        [IO.File]::WriteAllText($partialPath, ($receipt | ConvertTo-Json -Depth 8), $encoding)
        if (Test-Path -LiteralPath $receiptPath) {
            throw 'The runtime receipt destination appeared during finalization.'
        }
        [IO.File]::Move($partialPath, $receiptPath)
        return $receiptPath
    }
    finally {
        if (Test-Path -LiteralPath $partialPath -PathType Leaf) {
            [IO.File]::Delete($partialPath)
        }
    }
}

function Test-ExistingRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [string] $RuntimeRoot,

        [Parameter(Mandatory = $true)]
        [string] $ManifestSha256,

        [Parameter(Mandatory = $true)]
        [object[]] $Artifacts,

        [Parameter()]
        [switch] $AllowMissingReceipt
    )

    if (-not (Test-Path -LiteralPath $RuntimeRoot)) {
        return $false
    }
    if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
        throw ('InstallRoot exists but is not a directory: {0}' -f $RuntimeRoot)
    }

    $receiptPath = Get-SafeChildPath -Root $RuntimeRoot -RelativePath $script:ReceiptFileName
    if (-not (Test-Path -LiteralPath $receiptPath -PathType Leaf)) {
        if ($AllowMissingReceipt) {
            return $false
        }
        throw ('InstallRoot already exists without a trusted installer receipt; refusing to overwrite it: {0}' -f $RuntimeRoot)
    }
    $receiptItem = Get-Item -LiteralPath $receiptPath
    if (($receiptItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Existing runtime receipt cannot be a reparse point.'
    }
    if ($receiptItem.Length -gt 5242880) {
        throw 'Existing runtime receipt is unexpectedly large.'
    }

    try {
        $receipt = Get-Content -LiteralPath $receiptPath -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        throw ('Existing runtime receipt is invalid JSON: {0}' -f $_.Exception.Message)
    }
    Assert-ObjectProperties -InputObject $receipt -Names @(
        'version', 'bundle_id', 'kind', 'release_tag', 'target_commit',
        'manifest_sha256', 'source_artifacts', 'directories', 'files'
    ) -Label 'runtime receipt'

    if ([int]$receipt.version -ne 1 -or
        [string]$receipt.bundle_id -ne $script:ExpectedBundleId -or
        [string]$receipt.kind -ne 'llama.cpp-windows-cuda-runtime' -or
        [string]$receipt.release_tag -ne 'b10590' -or
        [string]$receipt.target_commit -ne '6657ded4faa3b8450221119fc6b4d002e35104a2') {
        throw 'Existing runtime receipt does not match this pinned llama.cpp release.'
    }

    $expectedArtifactMap = @{}
    foreach ($artifact in $Artifacts) {
        $expectedArtifactMap[$artifact.Id] = $artifact
    }
    $receiptArtifacts = @($receipt.source_artifacts)
    if ($receiptArtifacts.Count -ne $Artifacts.Count) {
        throw 'Existing runtime receipt has an unexpected source-artifact count.'
    }
    $seenReceiptArtifactIds = @{}
    foreach ($record in $receiptArtifacts) {
        Assert-ObjectProperties -InputObject $record -Names @('id', 'bytes', 'sha256') -Label 'receipt source artifact'
        $id = [string]$record.id
        if (-not $expectedArtifactMap.ContainsKey($id)) {
            throw ('Existing runtime receipt contains an unknown source artifact: {0}' -f $id)
        }
        if ($seenReceiptArtifactIds.ContainsKey($id)) {
            throw ('Existing runtime receipt contains a duplicate source artifact: {0}' -f $id)
        }
        $seenReceiptArtifactIds[$id] = $true
        $expected = $expectedArtifactMap[$id]
        if ([long]$record.bytes -ne $expected.Bytes -or [string]$record.sha256 -ne $expected.Sha256) {
            throw ('Existing runtime receipt source artifact mismatch: {0}' -f $id)
        }
    }

    Assert-NoRuntimeReparsePoints -RuntimeRoot $RuntimeRoot

    $receiptDirectories = @($receipt.directories)
    $directoryMap = @{}
    foreach ($record in $receiptDirectories) {
        Assert-ObjectProperties -InputObject $record -Names @('relative_path') -Label 'receipt directory'
        $relativePath = ([string]$record.relative_path).Replace('\', '/')
        if ([string]::IsNullOrWhiteSpace($relativePath)) {
            throw 'Existing runtime receipt contains an empty directory path.'
        }
        if ($directoryMap.ContainsKey($relativePath)) {
            throw ('Existing runtime receipt contains a duplicate directory path: {0}' -f $relativePath)
        }
        $null = Get-SafeChildPath -Root $RuntimeRoot -RelativePath $relativePath
        $directoryMap[$relativePath] = $true
    }

    $actualDirectories = @(Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -Force -Directory)
    if ($actualDirectories.Count -ne $directoryMap.Count) {
        throw 'Existing runtime contains missing or unrecorded directories; refusing to modify it.'
    }
    foreach ($directory in $actualDirectories) {
        $relativePath = Get-PortableRelativePath -Root $RuntimeRoot -Path $directory.FullName
        if (-not $directoryMap.ContainsKey($relativePath)) {
            throw ('Existing runtime contains an unrecorded directory: {0}' -f $relativePath)
        }
    }

    $receiptFiles = @($receipt.files)
    if ($receiptFiles.Count -eq 0) {
        throw 'Existing runtime receipt contains no managed files.'
    }
    $fileMap = @{}
    foreach ($record in $receiptFiles) {
        Assert-ObjectProperties -InputObject $record -Names @('relative_path', 'bytes', 'sha256') -Label 'receipt file'
        $relativePath = ([string]$record.relative_path).Replace('\', '/')
        if ($fileMap.ContainsKey($relativePath)) {
            throw ('Existing runtime receipt contains a duplicate path: {0}' -f $relativePath)
        }
        if ([long]$record.bytes -lt 0 -or [string]$record.sha256 -notmatch '^[0-9a-f]{64}$') {
            throw ('Existing runtime receipt contains invalid file metadata: {0}' -f $relativePath)
        }
        $null = Get-SafeChildPath -Root $RuntimeRoot -RelativePath $relativePath
        $fileMap[$relativePath] = $record
    }

    $actualFiles = @(Get-ChildItem -LiteralPath $RuntimeRoot -Recurse -Force -File | Where-Object { $_.FullName -ne $receiptPath })
    if ($actualFiles.Count -ne $fileMap.Count) {
        throw 'Existing runtime contains missing or unrecorded files; refusing to modify it.'
    }
    foreach ($file in $actualFiles) {
        $relativePath = Get-PortableRelativePath -Root $RuntimeRoot -Path $file.FullName
        if (-not $fileMap.ContainsKey($relativePath)) {
            throw ('Existing runtime contains an unrecorded file: {0}' -f $relativePath)
        }
        $expected = $fileMap[$relativePath]
        if ($file.Length -ne [long]$expected.bytes -or (Get-Sha256 -Path $file.FullName) -ne [string]$expected.sha256) {
            throw ('Existing runtime file failed verification: {0}' -f $relativePath)
        }
    }

    $null = Assert-LlamaServerExecutable -RuntimeRoot $RuntimeRoot
    return $true
}

function Get-VerifiedRuntimeArchivesFromCache {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Root,

        [Parameter(Mandatory = $true)]
        [object[]] $Artifacts
    )

    if (-not (Test-Path -LiteralPath $Root -PathType Container)) {
        throw ('Runtime archive cache does not exist: {0}' -f $Root)
    }

    $result = @{}
    foreach ($artifact in $Artifacts) {
        $finalPath = Get-SafeChildPath -Root $Root -RelativePath $artifact.FileName
        $candidatePaths = @($finalPath, ($finalPath + '.partial'))
        $verified = @()
        foreach ($candidate in $candidatePaths) {
            if (-not (Test-Path -LiteralPath $candidate)) {
                continue
            }
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
                throw ('Runtime archive candidate is not a file: {0}' -f $candidate)
            }
            if (-not (Test-ArtifactFile -Path $candidate -ExpectedBytes $artifact.Bytes -ExpectedSha256 $artifact.Sha256)) {
                throw ('Runtime archive candidate failed exact length/SHA-256 verification: {0}' -f $candidate)
            }
            $verified += $candidate
        }

        if ($verified.Count -eq 0) {
            throw ('No verified cache file is available for runtime artifact {0}.' -f $artifact.Id)
        }
        $result[$artifact.Id] = $verified[0]
    }

    return $result
}

function Assert-DirectoryTreesMatch {
    param(
        [Parameter(Mandatory = $true)]
        [string] $ExpectedRoot,

        [Parameter(Mandatory = $true)]
        [string] $ActualRoot
    )

    Assert-NoRuntimeReparsePoints -RuntimeRoot $ExpectedRoot
    Assert-NoRuntimeReparsePoints -RuntimeRoot $ActualRoot

    $expectedDirectories = @(Get-ChildItem -LiteralPath $ExpectedRoot -Recurse -Force -Directory | Sort-Object FullName)
    $actualDirectories = @(Get-ChildItem -LiteralPath $ActualRoot -Recurse -Force -Directory | Sort-Object FullName)
    $expectedDirectoryMap = @{}
    foreach ($directory in $expectedDirectories) {
        $relativePath = Get-PortableRelativePath -Root $ExpectedRoot -Path $directory.FullName
        $expectedDirectoryMap[$relativePath] = $true
    }
    $actualDirectoryMap = @{}
    foreach ($directory in $actualDirectories) {
        $relativePath = Get-PortableRelativePath -Root $ActualRoot -Path $directory.FullName
        $actualDirectoryMap[$relativePath] = $true
    }

    $expectedFiles = @(Get-ChildItem -LiteralPath $ExpectedRoot -Recurse -Force -File | Sort-Object FullName)
    $actualFiles = @(Get-ChildItem -LiteralPath $ActualRoot -Recurse -Force -File | Sort-Object FullName)
    $expectedMap = @{}
    foreach ($file in $expectedFiles) {
        $relativePath = Get-PortableRelativePath -Root $ExpectedRoot -Path $file.FullName
        $expectedMap[$relativePath] = [pscustomobject]@{
            Bytes = [long]$file.Length
            Sha256 = Get-Sha256 -Path $file.FullName
        }
    }

    $actualMap = @{}
    foreach ($file in $actualFiles) {
        $relativePath = Get-PortableRelativePath -Root $ActualRoot -Path $file.FullName
        $actualMap[$relativePath] = [pscustomobject]@{
            Bytes = [long]$file.Length
            Sha256 = Get-Sha256 -Path $file.FullName
        }
    }

    $differences = New-Object 'System.Collections.Generic.List[string]'
    foreach ($relativePath in @($expectedDirectoryMap.Keys | Sort-Object)) {
        if (-not $actualDirectoryMap.ContainsKey($relativePath)) {
            $differences.Add(('missing directory: {0}' -f $relativePath))
        }
    }
    foreach ($relativePath in @($actualDirectoryMap.Keys | Sort-Object)) {
        if (-not $expectedDirectoryMap.ContainsKey($relativePath)) {
            $differences.Add(('unexpected directory: {0}' -f $relativePath))
        }
    }
    foreach ($relativePath in @($expectedMap.Keys | Sort-Object)) {
        if (-not $actualMap.ContainsKey($relativePath)) {
            $differences.Add(('missing: {0}' -f $relativePath))
            continue
        }
        $expected = $expectedMap[$relativePath]
        $actual = $actualMap[$relativePath]
        if ($actual.Bytes -ne $expected.Bytes) {
            $differences.Add(('length mismatch: {0} (expected {1}, found {2})' -f $relativePath, $expected.Bytes, $actual.Bytes))
        }
        elseif ($actual.Sha256 -ne $expected.Sha256) {
            $differences.Add(('SHA-256 mismatch: {0} (expected {1}, found {2})' -f $relativePath, $expected.Sha256, $actual.Sha256))
        }
    }
    foreach ($relativePath in @($actualMap.Keys | Sort-Object)) {
        if (-not $expectedMap.ContainsKey($relativePath)) {
            $differences.Add(('unexpected: {0}' -f $relativePath))
        }
    }

    if ($differences.Count -gt 0) {
        throw ("Existing runtime does not exactly match the verified archives:`r`n - " + ($differences -join "`r`n - "))
    }
}

function Adopt-VerifiedRuntime {
    param(
        [Parameter(Mandatory = $true)]
        [string] $RuntimeRoot,

        [Parameter(Mandatory = $true)]
        [string] $ArchiveRoot,

        [Parameter(Mandatory = $true)]
        [string] $ManifestSha256,

        [Parameter(Mandatory = $true)]
        [object[]] $Artifacts
    )

    if (-not (Test-Path -LiteralPath $RuntimeRoot -PathType Container)) {
        throw ('Adoption requires an existing runtime directory: {0}' -f $RuntimeRoot)
    }
    $receiptPath = Get-SafeChildPath -Root $RuntimeRoot -RelativePath $script:ReceiptFileName
    if (Test-Path -LiteralPath $receiptPath) {
        throw 'Adoption is allowed only for an unreceipted runtime.'
    }

    $verifiedArchives = Get-VerifiedRuntimeArchivesFromCache -Root $ArchiveRoot -Artifacts $Artifacts
    $stageRoot = $null
    $runtimeParent = [IO.Directory]::GetParent($RuntimeRoot).FullName
    try {
        $stageRoot = New-OwnedStageDirectory -FinalRoot $RuntimeRoot
        $expectedPayload = Join-Path $stageRoot 'expected-payload'
        [IO.Directory]::CreateDirectory($expectedPayload) | Out-Null
        foreach ($artifact in @($Artifacts | Sort-Object Id)) {
            $expandedRoot = Join-Path $stageRoot ('expanded-' + $artifact.Id)
            Expand-VerifiedZipSafely -ArchivePath $verifiedArchives[$artifact.Id] -DestinationPath $expandedRoot
            Merge-DirectoryTree -SourceRoot $expandedRoot -DestinationRoot $expectedPayload
        }

        $null = Assert-LlamaServerExecutable -RuntimeRoot $expectedPayload
        $null = Assert-LlamaServerExecutable -RuntimeRoot $RuntimeRoot
        Assert-DirectoryTreesMatch -ExpectedRoot $expectedPayload -ActualRoot $RuntimeRoot
        $receipt = Write-RuntimeReceipt -RuntimeRoot $RuntimeRoot -ManifestSha256 $ManifestSha256 -Artifacts $Artifacts
        Write-Host ('Adopted exact verified runtime and installed receipt: {0}' -f $receipt)
    }
    finally {
        Remove-OwnedStageDirectory -StagePath $stageRoot -ExpectedParent $runtimeParent
    }
}

function New-OwnedStageDirectory {
    param(
        [Parameter(Mandatory = $true)]
        [string] $FinalRoot
    )

    $parent = [IO.Directory]::GetParent($FinalRoot)
    if ($null -eq $parent) {
        throw ('InstallRoot has no safe parent directory: {0}' -f $FinalRoot)
    }
    [IO.Directory]::CreateDirectory($parent.FullName) | Out-Null

    $stageName = $script:StagePrefix + [Guid]::NewGuid().ToString('N')
    $stagePath = Join-Path $parent.FullName $stageName
    [IO.Directory]::CreateDirectory($stagePath) | Out-Null
    return $stagePath
}

function Remove-OwnedStageDirectory {
    param(
        [Parameter()]
        [AllowNull()]
        [string] $StagePath,

        [Parameter(Mandatory = $true)]
        [string] $ExpectedParent
    )

    if ([string]::IsNullOrWhiteSpace($StagePath) -or -not (Test-Path -LiteralPath $StagePath)) {
        return
    }

    $stageFull = Get-NormalizedPath -Path $StagePath
    $parentFull = Get-NormalizedPath -Path $ExpectedParent
    $actualParent = [IO.Directory]::GetParent($stageFull)
    $leaf = [IO.Path]::GetFileName($stageFull)
    if ($null -eq $actualParent -or
        -not $actualParent.FullName.Equals($parentFull, [StringComparison]::OrdinalIgnoreCase) -or
        -not $leaf.StartsWith($script:StagePrefix, [StringComparison]::Ordinal)) {
        throw ('Refusing to clean an unowned staging path: {0}' -f $stageFull)
    }

    Remove-Item -LiteralPath $stageFull -Recurse -Force
}

function Test-ManualModels {
    param(
        [Parameter(Mandatory = $true)]
        [object[]] $Models,

        [Parameter(Mandatory = $true)]
        [string] $Root
    )

    $rootFull = Get-NormalizedPath -Path $Root
    Write-Host ('Model root (read-only verification): {0}' -f $rootFull)
    if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
        Write-Warning 'The model root does not exist yet. No folder was created.'
        return
    }

    foreach ($model in $Models) {
        $modelPath = Get-SafeChildPath -Root $rootFull -RelativePath $model.Model.RelativePath
        $presentProjectors = @()
        foreach ($projector in $model.Projectors) {
            $projectorPath = Get-SafeChildPath -Root $rootFull -RelativePath $projector.RelativePath
            if (Test-Path -LiteralPath $projectorPath) {
                if (-not (Test-ArtifactFile -Path $projectorPath -ExpectedBytes $projector.Bytes -ExpectedSha256 $projector.Sha256)) {
                    throw ('Manual projector failed length/SHA-256 verification: {0}' -f $projectorPath)
                }
                $presentProjectors += $projector
            }
        }

        if (-not (Test-Path -LiteralPath $modelPath)) {
            if ($presentProjectors.Count -gt 0) {
                Write-Warning ('{0}: verified projector present, but the reviewed quant-specific model is missing.' -f $model.ParameterSize)
            }
            else {
                Write-Host ('{0}: not downloaded.' -f $model.ParameterSize)
            }
            continue
        }

        if (-not (Test-ArtifactFile -Path $modelPath -ExpectedBytes $model.Model.Bytes -ExpectedSha256 $model.Model.Sha256)) {
            throw ('Manual model failed length/SHA-256 verification: {0}' -f $modelPath)
        }
        if ($presentProjectors.Count -eq 0) {
            Write-Warning ('{0}: model verified, but its exact pinned projector is missing.' -f $model.Directory)
            continue
        }

        $preferred = @($presentProjectors | Sort-Object @{ Expression = { if ($_.Variant -eq 'Q8_0') { 0 } else { 1 } } })[0]
        Write-Host ('{0}: READY (verified model + {1} projector).' -f $model.Directory, $preferred.Variant)
    }
}

function Resolve-RequestedModels {
    param(
        [Parameter(Mandatory = $true)]
        [object[]] $Models,

        [Parameter(Mandatory = $true)]
        [AllowEmptyCollection()]
        [string[]] $Names
    )

    $byDirectory = New-Object 'System.Collections.Generic.Dictionary[string,object]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($model in $Models) {
        $byDirectory[[string]$model.Directory] = $model
    }

    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $requested = @()
    foreach ($name in @($Names)) {
        if (-not $seen.Add($name)) {
            continue
        }
        if (-not $byDirectory.ContainsKey($name)) {
            throw ('Requested model is not in the pinned catalog: {0}' -f $name)
        }
        $requested += $byDirectory[$name]
    }
    return @($requested)
}

function Install-RequestedModels {
    param(
        [Parameter(Mandatory = $true)]
        [object[]] $Models,

        [Parameter(Mandatory = $true)]
        [string] $Root
    )

    if ($Models.Count -eq 0) {
        return
    }

    [IO.Directory]::CreateDirectory($Root) | Out-Null
    $client = $null
    try {
        $client = New-DownloadClient
        foreach ($model in $Models) {
            $destination = Get-SafeChildPath -Root $Root -RelativePath ([string]$model.Directory)
            [IO.Directory]::CreateDirectory($destination) | Out-Null
            Write-Host ('Ensuring pinned model pair: {0}' -f $model.Directory) -ForegroundColor Cyan
            $null = Get-VerifiedArtifact -Artifact $model.Model -DestinationRoot $destination -Client $client
            foreach ($projector in $model.Projectors) {
                $null = Get-VerifiedArtifact -Artifact $projector -DestinationRoot $destination -Client $client
            }
        }
    }
    finally {
        if ($null -ne $client) {
            $client.Dispose()
        }
    }
}

function Test-ModelReadme {
    param(
        [Parameter(Mandatory = $true)]
        [string] $TemplatePath,

        [Parameter(Mandatory = $true)]
        [string] $DestinationRoot
    )

    if (-not (Test-Path -LiteralPath $TemplatePath -PathType Leaf)) {
        throw ('Model README template was not found: {0}' -f $TemplatePath)
    }
    $templateItem = Get-Item -LiteralPath $TemplatePath
    if (($templateItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
        $templateItem.Length -le 0 -or $templateItem.Length -gt 1048576) {
        throw 'Model README template is unsafe or unexpectedly large.'
    }

    if (-not (Test-Path -LiteralPath $DestinationRoot)) {
        return $false
    }
    if (-not (Test-Path -LiteralPath $DestinationRoot -PathType Container)) {
        throw ('ModelRoot exists but is not a directory: {0}' -f $DestinationRoot)
    }

    $destinationPath = Get-SafeChildPath -Root $DestinationRoot -RelativePath ([IO.Path]::GetFileName($TemplatePath))
    if (-not (Test-Path -LiteralPath $destinationPath)) {
        return $false
    }
    if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
        throw ('Model README destination exists but is not a file: {0}' -f $destinationPath)
    }

    $destinationItem = Get-Item -LiteralPath $destinationPath
    if (($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Existing model README cannot be a reparse point.'
    }
    if ($destinationItem.Length -ne $templateItem.Length -or
        (Get-Sha256 -Path $destinationPath) -ne (Get-Sha256 -Path $TemplatePath)) {
        return $false
    }

    return $true
}

function Install-ModelReadme {
    param(
        [Parameter(Mandatory = $true)]
        [string] $TemplatePath,

        [Parameter(Mandatory = $true)]
        [string] $DestinationRoot
    )

    [IO.Directory]::CreateDirectory($DestinationRoot) | Out-Null
    $destinationPath = Get-SafeChildPath -Root $DestinationRoot -RelativePath ([IO.Path]::GetFileName($TemplatePath))
    $temporaryPath = $destinationPath + '.partial.' + [Guid]::NewGuid().ToString('N')
    try {
        [IO.File]::Copy($TemplatePath, $temporaryPath, $false)
        $templateItem = Get-Item -LiteralPath $TemplatePath
        if (-not (Test-ArtifactFile -Path $temporaryPath -ExpectedBytes $templateItem.Length -ExpectedSha256 (Get-Sha256 -Path $TemplatePath))) {
            throw 'Staged model README failed verification.'
        }

        if (Test-Path -LiteralPath $destinationPath) {
            if (Test-ModelReadme -TemplatePath $TemplatePath -DestinationRoot $DestinationRoot) {
                return $destinationPath
            }
            if (-not (Test-Path -LiteralPath $destinationPath -PathType Leaf)) {
                throw ('Model README destination is not a file: {0}' -f $destinationPath)
            }
            $destinationItem = Get-Item -LiteralPath $destinationPath
            if (($destinationItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Existing model README cannot be a reparse point.'
            }
            $backupPath = '{0}.backup-{1}' -f $destinationPath, (Get-Date -Format 'yyyyMMdd-HHmmss')
            [IO.File]::Replace($temporaryPath, $destinationPath, $backupPath, $true)
            return $destinationPath
        }

        [IO.File]::Move($temporaryPath, $destinationPath)
        return $destinationPath
    }
    finally {
        if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
            [IO.File]::Delete($temporaryPath)
        }
    }
}

$validatedManifest = Read-ArtifactManifest -Path $ManifestPath
$InstallRoot = Assert-SafeWritableRoot -Path $InstallRoot -Label 'InstallRoot'
$CacheRoot = Assert-SafeWritableRoot -Path $CacheRoot -Label 'CacheRoot'
$ModelRoot = Assert-SafeWritableRoot -Path $ModelRoot -Label 'ModelRoot'
$ModelReadmeTemplatePath = Get-NormalizedPath -Path $ModelReadmeTemplatePath
Assert-RootsDoNotOverlap -FirstPath $InstallRoot -FirstLabel 'InstallRoot' -SecondPath $CacheRoot -SecondLabel 'CacheRoot'
if (Test-SameOrChildPath -ParentPath $InstallRoot -CandidatePath $ModelRoot) {
    throw 'ModelRoot cannot equal or be nested under InstallRoot because its model README is not part of the runtime payload.'
}

$runtimeExistedBeforeValidation = Test-Path -LiteralPath $InstallRoot -PathType Container
$alreadyInstalled = Test-ExistingRuntime -RuntimeRoot $InstallRoot -ManifestSha256 $validatedManifest.Sha256 -Artifacts $validatedManifest.RuntimeArtifacts -AllowMissingReceipt:$AdoptVerifiedRuntime
$needsAdoption = $runtimeExistedBeforeValidation -and -not $alreadyInstalled
$readmeInstalled = Test-ModelReadme -TemplatePath $ModelReadmeTemplatePath -DestinationRoot $ModelRoot
$requestedModels = @(Resolve-RequestedModels -Models $validatedManifest.Models -Names $DownloadModels)
if ($alreadyInstalled -and $readmeInstalled -and $requestedModels.Count -eq 0) {
    Write-Host ('Pinned llama.cpp b10590 runtime is already installed and verified: {0}' -f $InstallRoot)
    if ($VerifyManualModels) {
        Test-ManualModels -Models $validatedManifest.Models -Root $ModelRoot
    }
    return
}

$action = if ($needsAdoption) {
    'reconstruct and byte-verify the existing llama.cpp b10590 runtime, add its receipt, copy the model README, and install requested pinned model pairs'
} else {
    'verify/install pinned llama.cpp b10590, copy the model README, and install requested pinned model pairs'
}
$modelTargets = @($requestedModels | ForEach-Object { Join-Path $ModelRoot $_.Directory })
$targets = (@($InstallRoot, (Join-Path $ModelRoot ([IO.Path]::GetFileName($ModelReadmeTemplatePath)))) + $modelTargets) -join '; '
if (-not $PSCmdlet.ShouldProcess($targets, $action)) {
    if ($VerifyManualModels) {
        Test-ManualModels -Models $validatedManifest.Models -Root $ModelRoot
    }
    return
}

if ($needsAdoption) {
    Adopt-VerifiedRuntime -RuntimeRoot $InstallRoot -ArchiveRoot $CacheRoot -ManifestSha256 $validatedManifest.Sha256 -Artifacts $validatedManifest.RuntimeArtifacts
    $alreadyInstalled = $true
}
elseif (-not $alreadyInstalled) {
    $downloadClient = $null
    $stageRoot = $null
    $installParent = [IO.Directory]::GetParent($InstallRoot).FullName
    try {
        [IO.Directory]::CreateDirectory($CacheRoot) | Out-Null
        $downloadClient = New-DownloadClient
        $verifiedArchives = @{}
        foreach ($artifact in $validatedManifest.RuntimeArtifacts) {
            $verifiedArchives[$artifact.Id] = Get-VerifiedArtifact -Artifact $artifact -DestinationRoot $CacheRoot -Client $downloadClient
        }

        $stageRoot = New-OwnedStageDirectory -FinalRoot $InstallRoot
        $payloadRoot = Join-Path $stageRoot 'payload'
        [IO.Directory]::CreateDirectory($payloadRoot) | Out-Null

        foreach ($artifact in @($validatedManifest.RuntimeArtifacts | Sort-Object Id)) {
            $expandedRoot = Join-Path $stageRoot ('expanded-' + $artifact.Id)
            Expand-VerifiedZipSafely -ArchivePath $verifiedArchives[$artifact.Id] -DestinationPath $expandedRoot
            Merge-DirectoryTree -SourceRoot $expandedRoot -DestinationRoot $payloadRoot
        }

        $serverPath = Assert-LlamaServerExecutable -RuntimeRoot $payloadRoot
        $null = Write-RuntimeReceipt -RuntimeRoot $payloadRoot -ManifestSha256 $validatedManifest.Sha256 -Artifacts $validatedManifest.RuntimeArtifacts

        if (Test-Path -LiteralPath $InstallRoot) {
            throw ('InstallRoot appeared while staging; refusing to overwrite it: {0}' -f $InstallRoot)
        }
        [IO.Directory]::Move($payloadRoot, $InstallRoot)
        Write-Host ('Installed verified llama.cpp b10590 runtime: {0}' -f $InstallRoot)
        Write-Host ('Verified server executable: {0}' -f (Join-Path $InstallRoot ([IO.Path]::GetFileName($serverPath))))
    }
    finally {
        if ($null -ne $downloadClient) {
            $downloadClient.Dispose()
        }
        Remove-OwnedStageDirectory -StagePath $stageRoot -ExpectedParent $installParent
    }

    $alreadyInstalled = Test-ExistingRuntime -RuntimeRoot $InstallRoot -ManifestSha256 $validatedManifest.Sha256 -Artifacts $validatedManifest.RuntimeArtifacts
}

if ($alreadyInstalled) {
    $null = Test-ExistingRuntime -RuntimeRoot $InstallRoot -ManifestSha256 $validatedManifest.Sha256 -Artifacts $validatedManifest.RuntimeArtifacts
}

if (-not $readmeInstalled) {
    $installedReadme = Install-ModelReadme -TemplatePath $ModelReadmeTemplatePath -DestinationRoot $ModelRoot
    Write-Host ('Installed model guide: {0}' -f $installedReadme)
}

Install-RequestedModels -Models $requestedModels -Root $ModelRoot

if ($VerifyManualModels) {
    Test-ManualModels -Models $validatedManifest.Models -Root $ModelRoot
}

Write-Host ('Pinned model root: {0}' -f $ModelRoot)
