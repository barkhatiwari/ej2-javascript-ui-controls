import { Spreadsheet } from '../../spreadsheet/index';
import { performUndoRedo, updateUndoRedoCollection, enableRibbonItems, ICellRenderer, updateAction, completeAction } from '../common/index';
import { UndoRedoEventArgs, setActionData, getBeforeActionData } from '../common/index';
import { BeforeActionData, PreviousCellDetails, CollaborativeEditArgs } from '../common/index';
import { selectRange, clearUndoRedoCollection } from '../common/index';
import { getRangeFromAddress, getRangeIndexes, BeforeCellFormatArgs, getSheet, workbookEditOperation } from '../../workbook/index';
import { getCell, setCell, CellModel, BeforeSortEventArgs, getSheetIndex } from '../../workbook/index';
import { SheetModel } from '../../workbook/index';

/**
 * UndoRedo module allows to perform undo redo functionalities.
 */
export class UndoRedo {
    private parent: Spreadsheet;
    private undoCollection: CollaborativeEditArgs[] = [];
    private redoCollection: CollaborativeEditArgs[] = [];
    private isUndo: boolean = false;
    private beforeActionData: BeforeActionData;
    private undoRedoStep: number = 100;
    constructor(parent: Spreadsheet) {
        this.parent = parent;
        this.addEventListener();
    }

    private setActionData(options: { args: CollaborativeEditArgs }): void {
        let sheet: SheetModel = this.parent.getActiveSheet();
        let address: number[];
        let cells: PreviousCellDetails[] = [];
        let cutCellDetails: PreviousCellDetails[] = [];
        let args: CollaborativeEditArgs = options.args;
        let eventArgs: UndoRedoEventArgs = args.eventArgs;
        switch (args.action) {
            case 'format':
                address = getRangeIndexes((args.eventArgs as BeforeCellFormatArgs).range);
                break;
            case 'clipboard':
                let copiedInfo: { [key: string]: Object } = eventArgs.copiedInfo;
                address = getRangeIndexes(getRangeFromAddress(eventArgs.pastedRange));
                if (copiedInfo.isCut) {
                    cutCellDetails = this.getCellDetails(copiedInfo.range as number[], getSheet(this.parent, copiedInfo.sId as number - 1));
                }
                break;
            case 'beforeSort':
                address = getRangeIndexes((args.eventArgs as BeforeSortEventArgs).range);
                if (address[0] === address[2] && (address[2] - address[0]) === 0) { //if selected range is a single cell 
                    address[0] = 0; address[1] = 0; address[2] = sheet.usedRange.rowIndex - 1; address[3] = sheet.usedRange.colIndex;
                }
                break;
            case 'beforeCellSave':
                address = getRangeIndexes(eventArgs.address);
                break;
        }
        cells = this.getCellDetails(address, sheet);
        this.beforeActionData = { cellDetails: cells, cutCellDetails: cutCellDetails };
    }

    private getBeforeActionData(args: { beforeDetails: BeforeActionData }): void {
        args.beforeDetails = this.beforeActionData;
    }

    private performUndoRedo(args: { isUndo: boolean, isPublic: boolean }): void {
        let undoRedoArgs: CollaborativeEditArgs = args.isUndo ? this.undoCollection.pop() : this.redoCollection.pop();
        this.isUndo = args.isUndo;
        if (undoRedoArgs) {
            switch (undoRedoArgs.action) {
                case 'cellSave':
                case 'format':
                case 'sorting':
                    undoRedoArgs = this.performOperation(undoRedoArgs);
                    break;
                case 'clipboard':
                    undoRedoArgs = this.undoForClipboard(undoRedoArgs);
                    break;
                case 'resize':
                    undoRedoArgs = this.undoForResize(undoRedoArgs);
                    break;
            }
            args.isUndo ? this.redoCollection.push(undoRedoArgs) : this.undoCollection.push(undoRedoArgs);
            if (this.undoCollection.length > this.undoRedoStep) {
                this.undoCollection.splice(0, 1);
            }
            if (this.redoCollection.length > this.undoRedoStep) {
                this.redoCollection.splice(0, 1);
            }
            this.updateUndoRedoIcons();
            let completeArgs: UndoRedoEventArgs = Object.assign({}, undoRedoArgs.eventArgs);
            completeArgs.requestType = args.isUndo ? 'undo' : 'redo';
            delete completeArgs.beforeActionData;
            if (!args.isPublic) {
                this.parent.notify(completeAction, { eventArgs: completeArgs, action: 'undoRedo' });
            }
        }
    }

    private updateUndoRedoCollection(options: { args: CollaborativeEditArgs, isPublic?: boolean }): void {
        let actionList: string[] = ['clipboard', 'format', 'sorting', 'cellSave', 'resize', 'resizeToFit'];
        let action: string = options.args.action;
        if (actionList.indexOf(action) === -1 && !options.isPublic) {
            return;
        }
        let eventArgs: UndoRedoEventArgs = options.args.eventArgs;
        if (action === 'clipboard' || action === 'sorting' || action === 'format' || action === 'cellSave') {
            let beforeActionDetails: { beforeDetails: BeforeActionData } = { beforeDetails: { cellDetails: [] } };
            this.parent.notify(getBeforeActionData, beforeActionDetails);
            eventArgs.beforeActionData = beforeActionDetails.beforeDetails;
        }
        this.undoCollection.push(options.args);
        this.redoCollection = [];
        if (this.undoCollection.length > this.undoRedoStep) {
            this.undoCollection.splice(0, 1);
        }
        this.updateUndoRedoIcons();
    }

    private clearUndoRedoCollection(): void {
        this.undoCollection = [];
        this.redoCollection = [];
        this.updateUndoRedoIcons();
    }

    private updateUndoRedoIcons(): void {
        this.parent.notify(enableRibbonItems, [{ id: this.parent.element.id + '_undo', isEnable: this.undoCollection.length > 0 }]);
        this.parent.notify(enableRibbonItems, [{ id: this.parent.element.id + '_redo', isEnable: this.redoCollection.length > 0 }]);
    }

    private undoForClipboard(args: CollaborativeEditArgs): CollaborativeEditArgs {
        let eventArgs: UndoRedoEventArgs = args.eventArgs;
        let address: string[] = eventArgs.pastedRange.split('!');
        let range: number[] = getRangeIndexes(address[1]);
        let sheetIndex: number = getSheetIndex(this.parent, address[0]);
        let sheet: SheetModel = getSheet(this.parent, sheetIndex);
        let copiedInfo: { [key: string]: Object } = eventArgs.copiedInfo;
        let actionData: BeforeActionData = eventArgs.beforeActionData;
        let isRefresh: boolean = this.checkRefreshNeeded(sheetIndex);
        if (this.isUndo) {
            if (copiedInfo.isCut) {
                let cells: PreviousCellDetails[] = actionData.cutCellDetails;
                this.updateCellDetails(cells, getSheet(this.parent, copiedInfo.sId as number - 1), copiedInfo.range as number[], isRefresh);
            }
            this.updateCellDetails(actionData.cellDetails, sheet, range, isRefresh);
        } else {
            updateAction(args, this.parent, copiedInfo.isCut as boolean);
        }
        if (isRefresh) {
            this.parent.notify(selectRange, range);
        }
        return args;
    }

    private undoForResize(args: CollaborativeEditArgs): CollaborativeEditArgs {
        let eventArgs: UndoRedoEventArgs = args.eventArgs;
        if (eventArgs.isCol) {
            let temp: string = eventArgs.oldWidth;
            eventArgs.oldWidth = eventArgs.width;
            eventArgs.width = temp;
        } else {
            let temp: string = eventArgs.oldHeight;
            eventArgs.oldHeight = eventArgs.height;
            eventArgs.height = temp;
        }
        updateAction(args, this.parent);
        return args;
    }

    private performOperation(args: CollaborativeEditArgs): CollaborativeEditArgs {
        let eventArgs: UndoRedoEventArgs = args.eventArgs;
        let address: string[] = (args.action === 'cellSave') ? eventArgs.address.split('!') : eventArgs.range.split('!');
        let range: number[] = getRangeIndexes(address[1]);
        let sheetIndex: number = getSheetIndex(this.parent, address[0]);
        let sheet: SheetModel = getSheet(this.parent, sheetIndex);
        let actionData: BeforeActionData = eventArgs.beforeActionData;
        let isRefresh: boolean = this.checkRefreshNeeded(sheetIndex);
        if (this.isUndo) {
            this.updateCellDetails(actionData.cellDetails, sheet, range, isRefresh);
        } else {
            updateAction(args, this.parent);
        }
        if (isRefresh) {
            this.parent.notify(selectRange, range);
        }
        return args;
    }
    private getCellDetails(address: number[], sheet: SheetModel): PreviousCellDetails[] {
        let cells: PreviousCellDetails[] = [];
        let cell: CellModel;
        for (let i: number = address[0]; i <= address[2]; i++) {
            for (let j: number = address[1]; j <= address[3]; j++) {
                cell = getCell(i, j, sheet);
                cells.push({
                    rowIndex: i, colIndex: j, format: cell ? cell.format : null,
                    style: cell ? cell.style : null, value: cell ? cell.value : '', formula: cell ? cell.formula : ''
                });
            }
        }
        return cells;
    }

    private updateCellDetails(cells: PreviousCellDetails[], sheet: SheetModel, range: number[], isRefresh: boolean): void {
        let len: number = cells.length;
        for (let i: number = 0; i < len; i++) {
            setCell(cells[i].rowIndex, cells[i].colIndex, sheet, {
                value: cells[i].value, format: cells[i].format,
                style: cells[i].style, formula: cells[i].formula
            });
            if (cells[i].formula) {
                this.parent.notify(
                    workbookEditOperation,
                    {
                        action: 'updateCellValue', address: [cells[i].rowIndex, cells[i].colIndex, cells[i].rowIndex,
                        cells[i].colIndex], value: cells[i].formula
                    });
            }
        }
        if (isRefresh) {
            this.parent.serviceLocator.getService<ICellRenderer>('cell').refreshRange(range);
        }
    }

    private checkRefreshNeeded(sheetIndex: number): boolean {
        let isRefresh: boolean = true;
        if (sheetIndex + 1 !== this.parent.activeSheetTab) {
            this.parent.activeSheetTab = sheetIndex + 1;
            this.parent.dataBind();
            isRefresh = false;
        }
        return isRefresh;
    }
    private addEventListener(): void {
        this.parent.on(performUndoRedo, this.performUndoRedo, this);
        this.parent.on(updateUndoRedoCollection, this.updateUndoRedoCollection, this);
        this.parent.on(setActionData, this.setActionData, this);
        this.parent.on(getBeforeActionData, this.getBeforeActionData, this);
        this.parent.on(clearUndoRedoCollection, this.clearUndoRedoCollection, this);
    }

    private removeEventListener(): void {
        if (!this.parent.isDestroyed) {
            this.parent.off(performUndoRedo, this.performUndoRedo);
            this.parent.off(updateUndoRedoCollection, this.updateUndoRedoCollection);
            this.parent.off(setActionData, this.setActionData);
            this.parent.off(getBeforeActionData, this.getBeforeActionData);
            this.parent.off(clearUndoRedoCollection, this.clearUndoRedoCollection);
        }
    }

    /**
     * Destroy undo redo module.
     */

    public destroy(): void {
        this.removeEventListener();
        this.parent = null;
    }
    /**
     * Get the undo redo module name.
     */
    public getModuleName(): string {
        return 'undoredo';
    }
}
