import * as vscode from 'vscode';
import { NetronEditorProvider } from './netronEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
    context.subscriptions.push(NetronEditorProvider.register(context));
}

export function deactivate(): void {}
