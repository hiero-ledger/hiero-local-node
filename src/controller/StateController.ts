/*-
 *
 * Hedera Local Node
 *
 * Copyright (C) 2023 Hedera Hashgraph, LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

import { StateData } from '../data/StateData';
import { LoggerService } from '../services/LoggerService';
import { ServiceLocator } from '../services/ServiceLocator';
import { CleanUpState } from '../state/CleanUpState';
import { EventType } from '../types/EventType';
import { StateConfiguration } from '../types/StateConfiguration';
import { IOBserver } from './IObserver';

export class StateController implements IOBserver{
    private logger: LoggerService;

    private stateConfiguration: StateConfiguration | undefined;

    private currStateNum: number;

    private maxStateNum: number;

    constructor(stateName: string) {
        this.logger = ServiceLocator.Current.get<LoggerService>(LoggerService.name);
        this.stateConfiguration = new StateData().getSelectedStateConfiguration(stateName);
        this.currStateNum = 0;
        this.maxStateNum = 0;
        this.logger.trace('State Controller Initialized!');
        this.logger.info(`Starting ${stateName} procedure!`);
    }

    public async startStateMachine() {
        if (!this.stateConfiguration) {
            this.logger.error('Something is wrong with state configuration!');
            // TODO: handle error
            process.exit(1);
        }

        this.maxStateNum = this.stateConfiguration.states.length;
        this.stateConfiguration!.states[this.currStateNum].subscribe(this);
        await this.stateConfiguration.states[this.currStateNum].onStart();
    }

    public async update(event: EventType): Promise<void> {
        if (event === EventType.Finish) {
            await this.transitionToNextState();
        } else {
            // TODO: depending on the error, try to add recovery state, else clean up and end
            const canRecover = false;
            if (canRecover) {
                // TODO: add recovery states based on error
            }
            await new CleanUpState().onStart();
            process.exit(1);
        }
    }

    private async transitionToNextState(): Promise<void> {
        if (!(this.currStateNum < this.maxStateNum)) {
            // TODO: handle end of program
            process.exit(0);
        }
        this.currStateNum+=1;

        try {
            this.stateConfiguration!.states[this.currStateNum].subscribe(this);
            await this.stateConfiguration!.states[this.currStateNum].onStart();
        } catch (error) {
            if (error instanceof TypeError) {
                // Ignore this error, it finds the methods and executes the code, but still results in TypeError
            } else {
                this.logger.error(`Trying to transition to next state was not possible. Error is: ${error}`);
            }
        }
    }
}
