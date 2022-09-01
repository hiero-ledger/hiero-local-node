/*
 * Copyright (C) 2020-2022 Hedera Hashgraph, LLC
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
 */
package com.hedera.services.bdd.spec.infrastructure.listeners;

import com.hedera.services.bdd.spec.HapiSpecOperation;
import com.hedera.services.bdd.spec.infrastructure.HapiSpecRegistry;
import com.hedera.services.bdd.spec.infrastructure.RegistryChangeContext;
import com.hedera.services.bdd.spec.infrastructure.RegistryChangeListener;
import java.util.HashSet;
import java.util.Optional;
import java.util.Set;
import java.util.function.Predicate;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

public class PresenceTrackingListener<T> implements RegistryChangeListener<T> {
    static final Logger log = LogManager.getLogger(PresenceTrackingListener.class);

    private final Class<T> type;
    private final HashSet<String> present = new HashSet<>();
    private final HapiSpecRegistry registry;
    private final Predicate<RegistryChangeContext<T>> filter;

    public PresenceTrackingListener(
            Class<T> type, HapiSpecRegistry registry, Predicate<RegistryChangeContext<T>> filter) {
        this.type = type;
        this.filter = filter;
        this.registry = registry;

        registry.register(this);
    }

    public PresenceTrackingListener(Class<T> type, HapiSpecRegistry registry) {
        this(type, registry, ignore -> true);
    }

    @Override
    public Class<T> forType() {
        return type;
    }

    @Override
    public synchronized void onPut(String name, T value, Optional<HapiSpecOperation> cause) {
        if (filter.test(new RegistryChangeContext<>(value, registry, cause))) {
            ensure(name);
        } else {
            remove(name);
        }
    }

    @Override
    public synchronized void onDelete(String name, Optional<HapiSpecOperation> cause) {
        remove(name);
    }

    private void ensure(String name) {
        if (log.isDebugEnabled()) {
            String tpl =
                    present.contains(name)
                            ? "%s '%s' is still available, but different."
                            : "%s '%s' is now available.";
            log.debug(String.format(tpl, type.getSimpleName(), name));
        }
        present.add(name);
    }

    private void remove(String name) {
        if (log.isDebugEnabled()) {
            log.debug(String.format("%s '%s' is no longer available.", type.getSimpleName(), name));
        }
        present.remove(name);
    }

    public synchronized Set<String> allKnown() {
        return present;
    }
}
