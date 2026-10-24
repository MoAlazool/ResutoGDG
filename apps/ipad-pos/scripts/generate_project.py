#!/usr/bin/env python3
"""Dependency-free deterministic Xcode project generator. Run from any directory."""
from pathlib import Path
import hashlib, json, plistlib
root=Path(__file__).resolve().parents[1]
project=root/'ResutoPOS.xcodeproj'; project.mkdir(exist_ok=True)
def uid(value): return hashlib.sha256(value.encode()).hexdigest()[:24].upper()
objects={}
def add(object_key, isa, **attrs):
    key=uid(object_key); objects[key]={'isa':isa,**attrs}; return key
class Ref(str): pass
def ref(v): return Ref(v)
app_sources=sorted([*root.glob('Sources/ResutoCore/*.swift'), *root.glob('App/*.swift')])
ui_sources=sorted(root.glob('UITests/*.swift'))
file_refs=[]; source_builds=[]; ui_builds=[]; resources=[]
for path in app_sources+ui_sources:
    rel=str(path.relative_to(root)); f=add(rel,'PBXFileReference',lastKnownFileType='sourcecode.swift',path=rel,sourceTree='<group>');file_refs.append(ref(f))
    build=add(rel+'-build','PBXBuildFile',fileRef=ref(f)); (ui_builds if path in ui_sources else source_builds).append(ref(build))
for path in sorted(root.glob('Resources/*')):
    if path.name=='Info.plist' or path.suffix=='.entitlements': continue
    rel=str(path.relative_to(root)); f=add(rel,'PBXFileReference',lastKnownFileType='text.xml',path=rel,sourceTree='<group>');file_refs.append(ref(f)); resources.append(ref(add(rel+'-build','PBXBuildFile',fileRef=ref(f))))
product=add('app-product','PBXFileReference',explicitFileType='wrapper.application',path='ResutoPOS.app',sourceTree='BUILT_PRODUCTS_DIR')
ui_product=add('ui-product','PBXFileReference',explicitFileType='wrapper.cfbundle',path='ResutoPOSUITests.xctest',sourceTree='BUILT_PRODUCTS_DIR')
products=add('products','PBXGroup',children=[ref(product),ref(ui_product)],name='Products',sourceTree='<group>')
main=add('main','PBXGroup',children=file_refs+[ref(products)],sourceTree='<group>')
def phase(name,isa,files): return ref(add(name,isa,buildActionMask=2147483647,files=files,runOnlyForDeploymentPostprocessing=0))
base={'SWIFT_VERSION':'5.0','IPHONEOS_DEPLOYMENT_TARGET':'17.0','SDKROOT':'iphoneos','TARGETED_DEVICE_FAMILY':'2','CLANG_ENABLE_MODULES':'YES','SWIFT_STRICT_CONCURRENCY':'targeted'}
def config_list(name, settings):
    configs=[]
    for mode in ['Debug','Release']:
        configs.append(ref(add(name+mode,'XCBuildConfiguration',name=mode,buildSettings={**settings,'SWIFT_OPTIMIZATION_LEVEL':'-Onone' if mode=='Debug' else '-O','DEBUG_INFORMATION_FORMAT':'dwarf-with-dsym','SWIFT_ACTIVE_COMPILATION_CONDITIONS':'DEBUG' if mode=='Debug' else ''})))
    return ref(add(name+'configs','XCConfigurationList',buildConfigurations=configs,defaultConfigurationIsVisible=0,defaultConfigurationName='Release'))
project_config=config_list('project',base)
app_config=config_list('app',{'PRODUCT_BUNDLE_IDENTIFIER':'com.resuto.ipadpos','PRODUCT_NAME':'$(TARGET_NAME)','INFOPLIST_FILE':'Resources/Info.plist','GENERATE_INFOPLIST_FILE':'NO','CODE_SIGN_STYLE':'Automatic','CODE_SIGN_ENTITLEMENTS':'Resources/ResutoPOS.entitlements','MARKETING_VERSION':'0.1.0','CURRENT_PROJECT_VERSION':'1','SUPPORTED_PLATFORMS':'iphoneos iphonesimulator','SUPPORTS_MACCATALYST':'NO','ENABLE_USER_SCRIPT_SANDBOXING':'YES'})
app_id=add('app','PBXNativeTarget',name='ResutoPOS',productName='ResutoPOS',productType='com.apple.product-type.application',productReference=ref(product),buildConfigurationList=app_config,buildPhases=[phase('app-sources','PBXSourcesBuildPhase',source_builds),phase('app-frameworks','PBXFrameworksBuildPhase',[]),phase('app-resources','PBXResourcesBuildPhase',resources)],buildRules=[],dependencies=[])
fixture_ref=add('test-fixtures','PBXFileReference',lastKnownFileType='folder',path='Tests/ResutoCoreTests/Fixtures',sourceTree='<group>')
objects[main]['children'].append(ref(fixture_ref))
fixture_build=add('test-fixtures-build','PBXBuildFile',fileRef=ref(fixture_ref))
proxy=add('ui-proxy','PBXContainerItemProxy',containerPortal=ref(uid('project')),proxyType=1,remoteGlobalIDString=ref(app_id),remoteInfo='ResutoPOS')
dep=add('ui-dependency','PBXTargetDependency',target=ref(app_id),targetProxy=ref(proxy))
ui_config=config_list('ui',{'PRODUCT_BUNDLE_IDENTIFIER':'com.resuto.ipadpos.uitests','PRODUCT_NAME':'$(TARGET_NAME)','GENERATE_INFOPLIST_FILE':'YES','TEST_TARGET_NAME':'ResutoPOS','CODE_SIGN_STYLE':'Automatic'})
ui_id=add('ui','PBXNativeTarget',name='ResutoPOSUITests',productName='ResutoPOSUITests',productType='com.apple.product-type.bundle.ui-testing',productReference=ref(ui_product),buildConfigurationList=ui_config,buildPhases=[phase('ui-sources','PBXSourcesBuildPhase',ui_builds),phase('ui-frameworks','PBXFrameworksBuildPhase',[]),phase('ui-resources','PBXResourcesBuildPhase',[ref(fixture_build)])],buildRules=[],dependencies=[ref(dep)])
project_id=add('project','PBXProject',attributes={'BuildIndependentTargetsInParallel':'YES','LastUpgradeCheck':'1600','TargetAttributes':{ui_id:{'TestTargetID':ref(app_id)}}},buildConfigurationList=project_config,compatibilityVersion='Xcode 14.0',developmentRegion='en',knownRegions=['en','ar','Base'],mainGroup=ref(main),productRefGroup=ref(products),projectDirPath='',projectRoot='',targets=[ref(app_id),ref(ui_id)])
def encode(v, depth=0):
    if isinstance(v,Ref): return v
    if isinstance(v,dict): return '{\n'+''.join('\t'*(depth+1)+json.dumps(k)+' = '+encode(value,depth+1)+';\n' for k,value in v.items())+'\t'*depth+'}'
    if isinstance(v,list): return '('+', '.join(encode(value,depth+1) for value in v)+')'
    if isinstance(v,int): return str(v)
    return json.dumps(v)
(project/'project.pbxproj').write_text('// !$*UTF8*$!\n'+encode({'archiveVersion':1,'classes':{},'objectVersion':56,'objects':objects,'rootObject':ref(project_id)})+'\n')
schemes=project/'xcshareddata/xcschemes';schemes.mkdir(parents=True,exist_ok=True)
def buildref(id,name,product): return f'<BuildableReference BuildableIdentifier="primary" BlueprintIdentifier="{id}" BuildableName="{product}" BlueprintName="{name}" ReferencedContainer="container:ResutoPOS.xcodeproj"/>'
app_ref=buildref(app_id,'ResutoPOS','ResutoPOS.app');ui_ref=buildref(ui_id,'ResutoPOSUITests','ResutoPOSUITests.xctest')
(schemes/'ResutoPOS.xcscheme').write_text(f'''<?xml version="1.0" encoding="UTF-8"?>
<Scheme LastUpgradeVersion="1600" version="1.7">
<BuildAction parallelizeBuildables="YES" buildImplicitDependencies="YES"><BuildActionEntries><BuildActionEntry buildForTesting="YES" buildForRunning="YES" buildForProfiling="YES" buildForArchiving="YES" buildForAnalyzing="YES">{app_ref}</BuildActionEntry></BuildActionEntries></BuildAction>
<TestAction buildConfiguration="Debug" shouldUseLaunchSchemeArgsEnv="YES"><Testables><TestableReference skipped="NO">{ui_ref}</TestableReference></Testables></TestAction>
<LaunchAction buildConfiguration="Debug" launchStyle="0" useCustomWorkingDirectory="NO" ignoresPersistentStateOnLaunch="NO" debugDocumentVersioning="YES" debugServiceExtension="internal" allowLocationSimulation="YES"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></LaunchAction>
<ProfileAction buildConfiguration="Release" shouldUseLaunchSchemeArgsEnv="YES" useCustomWorkingDirectory="NO" debugDocumentVersioning="YES"><BuildableProductRunnable runnableDebuggingMode="0">{app_ref}</BuildableProductRunnable></ProfileAction>
<AnalyzeAction buildConfiguration="Debug"/><ArchiveAction buildConfiguration="Release" revealArchiveInOrganizer="YES"/>
</Scheme>\n''')
print('Generated', project.name)
