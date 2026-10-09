// Writes dist/hosted/manifest.xml for the no-install build. The manifest is the
// only file a user uploads to PowerPoint ("Upload My Add-in"); everything it
// points to is the static site at HOSTED_BASE_URL (e.g. GitHub Pages).
//   HOSTED_BASE_URL=https://<user>.github.io/<repo>/ npm run build:hosted
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = process.env.HOSTED_BASE_URL || 'https://localhost:4320/';
const base = new URL(raw.endsWith('/') ? raw : raw + '/');
if (base.protocol !== 'https:') throw new Error('HOSTED_BASE_URL must be an https:// URL (Office add-ins require HTTPS).');
const at = (file) => new URL(file, base).href;
const escape = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const taskpane = escape(at('taskpane.html?taskpane=1'));
// A fixed id that differs from the local app's add-in, so both can be installed.
const id = 'ca97aec5-d992-42b2-9659-1302e358ab69';

const manifest = `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
           xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
           xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
           xmlns:ov="http://schemas.microsoft.com/office/taskpaneappversionoverrides"
           xsi:type="TaskPaneApp">
  <Id>${id}</Id>
  <Version>1.2.0.0</Version>
  <ProviderName>Designer Extention</ProviderName>
  <DefaultLocale>ja-JP</DefaultLocale>
  <DisplayName DefaultValue="Designer Extention" />
  <Description DefaultValue="資料と指示から、PowerPointのスライド作成を支援します（インストール不要版）。" />
  <IconUrl DefaultValue="${escape(at('office-icon-32.png'))}" />
  <HighResolutionIconUrl DefaultValue="${escape(at('office-icon-80.png'))}" />
  <SupportUrl DefaultValue="${escape(at('index.html'))}" />
  <AppDomains>
    <AppDomain>${escape(base.origin)}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Presentation" />
  </Hosts>
  <DefaultSettings>
    <SourceLocation DefaultValue="${taskpane}" />
  </DefaultSettings>
  <Permissions>ReadWriteDocument</Permissions>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/taskpaneappversionoverrides" xsi:type="VersionOverridesV1_0">
    <Hosts>
      <Host xsi:type="Presentation">
        <DesktopFormFactor>
          <GetStarted>
            <Title resid="start.title" />
            <Description resid="start.description" />
            <LearnMoreUrl resid="taskpane.url" />
          </GetStarted>
          <ExtensionPoint xsi:type="PrimaryCommandSurface">
            <OfficeTab id="TabHome">
              <Group id="designer.web.group">
                <Label resid="group.label" />
                <Icon>
                  <bt:Image size="16" resid="icon.16" />
                  <bt:Image size="32" resid="icon.32" />
                  <bt:Image size="80" resid="icon.80" />
                </Icon>
                <Control xsi:type="Button" id="designer.web.showTaskPane">
                  <Label resid="button.label" />
                  <Supertip>
                    <Title resid="button.label" />
                    <Description resid="button.tip" />
                  </Supertip>
                  <Icon>
                    <bt:Image size="16" resid="icon.16" />
                    <bt:Image size="32" resid="icon.32" />
                    <bt:Image size="80" resid="icon.80" />
                  </Icon>
                  <Action xsi:type="ShowTaskpane">
                    <TaskpaneId>DesignerExtentionWebTaskPane</TaskpaneId>
                    <SourceLocation resid="taskpane.url" />
                  </Action>
                </Control>
              </Group>
            </OfficeTab>
          </ExtensionPoint>
        </DesktopFormFactor>
      </Host>
    </Hosts>
    <Resources>
      <bt:Images>
        <bt:Image id="icon.16" DefaultValue="${escape(at('office-icon-16.png'))}" />
        <bt:Image id="icon.32" DefaultValue="${escape(at('office-icon-32.png'))}" />
        <bt:Image id="icon.80" DefaultValue="${escape(at('office-icon-80.png'))}" />
      </bt:Images>
      <bt:Urls>
        <bt:Url id="taskpane.url" DefaultValue="${taskpane}" />
      </bt:Urls>
      <bt:ShortStrings>
        <bt:String id="group.label" DefaultValue="Designer Extention" />
        <bt:String id="button.label" DefaultValue="スライド作成" />
        <bt:String id="start.title" DefaultValue="Designer Extention" />
      </bt:ShortStrings>
      <bt:LongStrings>
        <bt:String id="button.tip" DefaultValue="資料と指示からスライドを作成し、選択中のスライドの図解・要約や発表準備を行います。" />
        <bt:String id="start.description" DefaultValue="ホームタブの「スライド作成」から右側のペインを開いてください。" />
      </bt:LongStrings>
    </Resources>
  </VersionOverrides>
</OfficeApp>
`;
await writeFile(path.join(root, 'dist', 'hosted', 'manifest.xml'), manifest, 'utf8');
await writeFile(path.join(root, 'dist', 'hosted', '.nojekyll'), '', 'utf8');
console.log(`Manifest for ${base.href} -> dist/hosted/manifest.xml`);
if (['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) console.warn('Note: this manifest points to localhost. It works only in desktop PowerPoint; PowerPoint for the web (Edge/Chrome 142+) blocks localhost add-ins as local network access. Publish to a public HTTPS URL (HOSTED_BASE_URL) for the web.');
