/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

export class Logger implements vscode.Disposable {

	private readonly _channel: vscode.LogOutputChannel;

	constructor(name: string) {
		this._channel = vscode.window.createOutputChannel(name, { log: true });
	}

	info(message: string): void {
		this._channel.info(message);
	}

	warn(message: string): void {
		this._channel.warn(message);
	}

	error(message: string, error?: unknown): void {
		this._channel.error(error instanceof Error ? `${message}: ${error.message}` : message);
	}

	show(): void {
		this._channel.show();
	}

	dispose(): void {
		this._channel.dispose();
	}
}
