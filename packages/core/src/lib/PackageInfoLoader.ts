/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails oncall+ws_labs
 * @format
 */
import fs from 'fs-extra';
import path from 'path';
import {IPackageInfo} from '..';
import config from './Config';
import utils from './Utils';

/** @internal */
export class PackageInfoLoader {
  private static registeredPackages: Set<string> = new Set();

  private static async loadFrom(
    packageDirectory: string,
  ): Promise<IPackageInfo> {
    let exists = await fs.pathExists(packageDirectory);
    if (!exists) {
      throw utils.haltOrThrow(
        `package directory doesn't exist: ${packageDirectory}`,
      );
    }
    let packageJSONFile = path.join(packageDirectory, 'package-oss.json');
    exists = await fs.pathExists(packageJSONFile);
    if (!exists) {
      packageJSONFile = path.join(packageDirectory, 'package.json');
    }
    exists = await fs.pathExists(packageJSONFile);
    if (!exists) {
      throw utils.haltOrThrow(`package.json doesn't exist: ${packageJSONFile}`);
    }
    try {
      const metaData = await fs.readJSON(packageJSONFile, 'UTF-8');
      return {...metaData, packageLocation: packageDirectory};
    } catch (ex) {
      throw utils.haltOrThrow(utils.getError(ex));
    }
  }

  public static async registerPackage(packageDirectory: string): Promise<void> {
    if (!PackageInfoLoader.registeredPackages.has(packageDirectory)) {
      PackageInfoLoader.registeredPackages.add(packageDirectory);
      const packageInfo = await PackageInfoLoader.loadFrom(packageDirectory);
      config._packageInfo.push(packageInfo);
    }
  }
}
