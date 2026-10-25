/**
 * electron-builder afterPack hook: writes the icon and the version information
 * into Mockix.exe.
 *
 * electron-builder's own step (signAndEditExecutable) runs right after the
 * fuses are flipped and, on some Windows machines, fails with "UNKNOWN:
 * unknown error, open …Mockix.exe" while something scans the fresh
 * executable. Here the edit happens a step earlier and is retried while the
 * file stays locked.
 */
const path = require("node:path");
const { editWindowsResources } = require("app-builder-lib/out/util/resEdit");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const { appInfo } = context.packager;
  const file = path.join(context.appOutDir, `${appInfo.productFilename}.exe`);
  const version = appInfo.version;
  const options = {
    file,
    fileVersion: `${version.replace(/[-+].*$/, "")}.0`,
    productVersion: version,
    iconPath: path.join(context.packager.info.projectDir, "build", "icon.ico"),
    versionStrings: {
      FileDescription: appInfo.productName,
      ProductName: appInfo.productName,
      CompanyName: "protohub.digital",
      LegalCopyright: appInfo.copyright,
      InternalName: appInfo.productFilename,
      OriginalFilename: `${appInfo.productFilename}.exe`,
    },
  };
  for (let attempt = 1; ; attempt++) {
    try {
      await editWindowsResources(options);
      console.log(`  • ${appInfo.productFilename}.exe: icon and version ${version} written (attempt ${attempt})`);
      return;
    } catch (err) {
      if (attempt >= 15) throw err;
      await sleep(1000);
    }
  }
};
