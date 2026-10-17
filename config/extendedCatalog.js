// Additive product templates for the client's mixed electronics and home store.
// Saved definitions win, so upgrades never replace a store's existing fields.
const field = (key, label, type = 'text', extra = {}) => ({
  key, label, type, unit: '', required: false, filterable: false, searchable: true,
  showOnCard: false, showOnDetail: true, showInSpecifications: true, variant: false,
  options: [], defaultValue: '', sortOrder: 100, group: 'Specifications', validation: {}, ...extra,
});
const number = (key, label, unit = '') => field(key, label, 'measurement', { unit, validation: { min: 0 } });
const choice = (key, label, options) => field(key, label, 'dropdown', { options, filterable: true });
const notes = (key, label) => field(key, label, 'textarea');
const yesNo = (key, label) => field(key, label, 'boolean');
const power = [number('power_consumption', 'Rated power', 'W'), field('voltage', 'Rated voltage / frequency')];
const common = [
  field('brand', 'Brand', 'text', { filterable: true }), field('model', 'Model / model number'),
  { ...choice('condition', 'Condition', ['New', 'Refurbished', 'Used']), required: true },
  field('warranty', 'Warranty period'), field('dimensions', 'Product dimensions (include unit)'),
  number('weight', 'Product weight', 'kg'), notes('box_contents', 'Included components'),
];
const template = (key, name, attributes, overrides = {}) => ({
  key, name, parentKey: '', active: true,
  attributes: [...common.map(item => ({ ...item, ...overrides[item.key] })), ...attributes].map((item, index) => ({ ...item, sortOrder: 100 + index })),
  variantAttributes: ['colour'], filters: ['brand', 'price', 'availability'],
});
const audio = [
  field('connectivity', 'Connectivity / supported inputs'), number('driver_size', 'Driver size', 'mm'),
  field('frequency_response', 'Frequency response'), number('impedance', 'Impedance', 'ohm'),
  number('battery_life', 'Playback time', 'h'), field('charging_time', 'Charging time'),
  yesNo('microphone', 'Microphone'), field('water_resistance', 'Water resistance rating'),
];
const templates = [
  template('watches', 'Watches (digital & analogue)', [
    choice('watch_type', 'Watch type', ['Digital', 'Analogue', 'Analogue-digital']),
    field('movement', 'Movement'), field('display_type', 'Display type'),
    field('case_material', 'Case material'), field('case_shape', 'Case shape'),
    number('case_diameter', 'Case diameter', 'mm'), number('case_thickness', 'Case thickness', 'mm'),
    field('strap_material', 'Strap material'), number('strap_width', 'Strap width', 'mm'),
    field('strap_size', 'Strap / wrist size'), field('clasp_type', 'Clasp type'),
    field('dial_colour', 'Dial colour'), field('water_resistance', 'Water resistance rating'),
    field('power_source', 'Power source / battery type'), field('battery_life', 'Battery life (include unit)'),
    yesNo('backlight', 'Backlight'), yesNo('alarm', 'Alarm'), yesNo('stopwatch', 'Stopwatch'),
    yesNo('date_display', 'Date display'), notes('features', 'Additional features'),
  ], { weight: { unit: 'g' } }),
  template('hair_dryers', 'Hair dryers', [
    ...power, field('motor_type', 'Motor type'), number('speed_settings', 'Speed settings'),
    number('heat_settings', 'Heat settings'), yesNo('cool_shot', 'Cool shot'),
    yesNo('ionic_technology', 'Ionic technology'), field('attachments', 'Nozzles / attachments'),
    yesNo('foldable_handle', 'Foldable handle'), number('cord_length', 'Cord length', 'm'),
    field('airflow', 'Airflow (include unit)'), notes('safety_features', 'Safety features'),
    notes('usage_instructions', 'Use and care'),
  ]),
  template('personal_care', 'Trimmers, shavers & personal care', [
    field('product_type', 'Personal care product type'), ...power,
    field('blade_material', 'Blade / plate material'), field('length_settings', 'Length / temperature settings'),
    field('operating_mode', 'Corded / cordless operation'), number('battery_life', 'Runtime', 'min'),
    field('charging_time', 'Charging time'), field('water_resistance', 'Water resistance / washable parts'),
    field('attachments', 'Attachments'), notes('safety_features', 'Safety features'), notes('usage_instructions', 'Use and care'),
  ]),
  template('torches_lights', 'Torches & emergency lights', [
    field('light_type', 'Torch / light type'), field('light_source', 'Light source'),
    number('light_output', 'Light output', 'lm'), number('beam_distance', 'Beam distance', 'm'),
    number('output_power', 'Light power', 'W'), field('lighting_modes', 'Lighting modes'),
    field('charging_method', 'Charging method'), yesNo('solar_charging', 'Solar charging'),
    number('battery_capacity', 'Battery capacity', 'mAh'), field('battery_type', 'Battery type'),
    field('battery_life', 'Runtime (include mode)'), field('charging_time', 'Charging time'),
    field('water_resistance', 'Water resistance rating'), field('material', 'Body material'),
    notes('safety_features', 'Safety features'), notes('usage_instructions', 'Use and care'),
  ]),
  template('general_products', 'Other products / custom specifications', [
    field('product_type', 'Product type'), field('material', 'Material'), field('capacity', 'Capacity (include unit)'),
    notes('features', 'Features'), notes('usage_instructions', 'Use and care'),
  ]),
  template('televisions', 'Televisions', [
    number('screen_size', 'Screen size', 'in'), field('resolution', 'Display resolution'),
    field('panel_type', 'Panel / display technology'), number('refresh_rate', 'Refresh rate', 'Hz'),
    field('smart_tv_platform', 'Smart TV platform / OS'), yesNo('smart_tv', 'Smart TV'),
    field('hdr_formats', 'HDR formats'), number('audio_output', 'Speaker output', 'W'),
    field('hdmi_ports', 'HDMI ports / version'), field('usb_ports', 'USB ports'),
    field('connectivity', 'Wi-Fi / Bluetooth / other connectivity'), field('casting', 'Casting support'),
    field('vesa_mount', 'VESA mount size'), field('energy_rating', 'Energy rating / label year'),
    notes('installation', 'Installation / wall mount included'), ...power,
  ]),
  template('speakers', 'Speakers & soundbars', [
    field('speaker_type', 'Speaker type'), number('output_power', 'RMS output power', 'W'),
    field('channels', 'Audio channels'), ...audio, number('battery_capacity', 'Battery capacity', 'mAh'),
    yesNo('fm_radio', 'FM radio'), field('supported_formats', 'Supported audio formats'), ...power,
  ]),
  template('headphones', 'Headphones', [
    field('headphone_type', 'Headphone type / fit'), ...audio, yesNo('anc', 'Active noise cancellation'),
    field('audio_codecs', 'Supported codecs'), field('bluetooth', 'Bluetooth version'),
    field('connector_type', 'Connector / charging port'),
  ]),
  template('earphones', 'Earphones & earbuds', [
    ...audio, field('earphone_type', 'Earphone type'), yesNo('anc', 'Active noise cancellation'),
    field('audio_codecs', 'Supported codecs'), field('bluetooth', 'Bluetooth version'),
    field('connector_type', 'Connector / charging port'), field('case_battery_life', 'Playback with charging case'),
  ]),
  template('screen_protectors', 'Screen guards & protectors', [
    field('protector_type', 'Protector type'), notes('compatible_devices', 'Compatible models / exact fit'),
    field('material', 'Material'), field('hardness', 'Hardness rating'), number('thickness', 'Thickness', 'mm'),
    field('coverage', 'Coverage / edge fit'), field('finish', 'Finish / privacy / anti-glare'),
    number('pack_quantity', 'Number in pack'), yesNo('installation_kit', 'Installation kit included'),
  ]),
  template('irons', 'Irons / garment steamers', [
    field('iron_type', 'Iron / steamer type'), ...power, field('soleplate', 'Soleplate material / coating'),
    number('water_tank_capacity', 'Water tank capacity', 'ml'), number('steam_output', 'Steam output', 'g/min'),
    yesNo('temperature_control', 'Adjustable temperature'), yesNo('auto_shutoff', 'Automatic shut-off'),
    number('cord_length', 'Cord length', 'm'), notes('safety_features', 'Safety features'),
  ]),
  template('washing_machines', 'Washing machines', [
    number('wash_capacity', 'Wash capacity', 'kg'), number('dryer_capacity', 'Drying capacity', 'kg'),
    choice('loading_type', 'Loading type', ['Front load', 'Top load']),
    choice('automation', 'Operation', ['Fully automatic', 'Semi automatic', 'Manual']),
    number('spin_speed', 'Maximum spin speed', 'rpm'), field('energy_rating', 'Energy rating / label year'),
    field('motor_type', 'Motor / inverter technology'), field('drum_material', 'Drum material'),
    notes('wash_programs', 'Wash programs'), yesNo('inbuilt_heater', 'Inbuilt heater'),
    number('water_consumption', 'Water consumption per cycle', 'l'), field('noise_level', 'Noise level'),
    notes('installation', 'Installation requirements'), ...power,
  ]),
  template('pressure_cookers', 'Pressure cookers', [
    number('capacity_litres', 'Capacity', 'l'), field('material', 'Body material'),
    choice('lid_type', 'Lid type', ['Inner lid', 'Outer lid', 'Clip-on']),
    field('base_type', 'Base type / thickness'), yesNo('induction_compatible', 'Induction compatible'),
    yesNo('gas_compatible', 'Gas stove compatible'), field('handle_material', 'Handle material'),
    notes('safety_features', 'Safety features'), number('pack_quantity', 'Number in pack'),
    notes('usage_instructions', 'Use and care'),
  ]),
  template('mixer_grinders', 'Mixer grinders / blenders / juicers', [
    field('appliance_type', 'Mixer / blender / juicer type'), ...power,
    number('jar_count', 'Number of jars'), field('jar_capacities', 'Jar capacities (include units)'),
    field('jar_material', 'Jar material'), field('blade_material', 'Blade material'),
    number('speed_settings', 'Speed settings'), number('motor_speed', 'Motor speed', 'rpm'),
    yesNo('pulse_function', 'Pulse function'), yesNo('overload_protection', 'Overload protection'),
    notes('functions', 'Grinding / blending functions'), notes('usage_instructions', 'Use and care'),
  ]),
  template('refrigerators', 'Refrigerators & freezers', [
    number('capacity_litres', 'Total capacity', 'l'), number('freezer_capacity', 'Freezer capacity', 'l'),
    field('refrigerator_type', 'Refrigerator type'), number('door_count', 'Number of doors'),
    field('defrost_type', 'Defrost technology'), field('energy_rating', 'Energy rating / label year'),
    field('compressor_type', 'Compressor type'), field('refrigerant', 'Refrigerant'),
    notes('features', 'Cooling / storage features'), ...power,
  ]),
  template('air_conditioners', 'Air conditioners', [
    field('ac_type', 'AC type'), number('cooling_capacity_ton', 'Cooling capacity', 'ton'),
    field('energy_rating', 'Energy rating / label year'), field('iseer', 'ISEER rating'),
    field('compressor_type', 'Compressor / inverter type'), field('refrigerant', 'Refrigerant'),
    field('room_coverage', 'Recommended room area (include unit)'), field('noise_level', 'Noise level'),
    notes('installation', 'Installation requirements / kit'), ...power,
  ]),
  template('fans_coolers', 'Fans & air coolers', [
    field('appliance_type', 'Fan / cooler type'), ...power, number('sweep_size', 'Fan sweep', 'mm'),
    number('air_delivery', 'Air delivery', 'm3/min'), number('speed_settings', 'Speed settings'),
    number('tank_capacity', 'Cooler tank capacity', 'l'), field('room_coverage', 'Coverage area'),
    yesNo('remote_control', 'Remote control'), notes('features', 'Features'),
  ]),
  template('microwave_ovens', 'Microwaves / ovens / air fryers', [
    field('oven_type', 'Oven / air fryer type'), number('capacity_litres', 'Capacity', 'l'), ...power,
    field('temperature_range', 'Temperature range'), notes('cooking_modes', 'Cooking modes / presets'),
    field('cavity_material', 'Cavity material'), notes('usage_instructions', 'Use and care'),
  ]),
  template('cooktops', 'Induction / gas cooktops', [
    field('cooktop_type', 'Cooktop type'), number('burner_count', 'Burners / cooking zones'),
    field('surface_material', 'Surface material'), field('control_type', 'Controls / ignition'),
    field('compatible_cookware', 'Compatible cookware'), ...power, notes('safety_features', 'Safety features'),
  ]),
  template('kettles_rice_cookers', 'Kettles / rice cookers', [
    field('appliance_type', 'Appliance type'), number('capacity_litres', 'Capacity', 'l'), ...power,
    field('material', 'Body / inner pot material'), yesNo('auto_shutoff', 'Automatic shut-off'),
    yesNo('keep_warm', 'Keep warm'), notes('functions', 'Functions / controls'),
  ]),
  template('water_purifiers', 'Water purifiers', [
    field('purification_technology', 'Purification technology'), number('tank_capacity', 'Storage capacity', 'l'),
    field('purification_rate', 'Purification rate (l/h)'), field('tds_range', 'Supported input TDS'),
    number('filter_stages', 'Purification stages'), field('installation_type', 'Installation type'),
    notes('filter_maintenance', 'Filter life / maintenance'), ...power,
  ]),
  template('laptops', 'Laptops & computers', [
    field('processor', 'Processor'), number('ram', 'RAM', 'GB'), number('storage', 'Storage', 'GB'),
    field('storage_type', 'Storage type'), field('gpu', 'Graphics'), number('screen_size', 'Screen size', 'in'),
    field('resolution', 'Resolution'), field('operating_system', 'Operating system'),
    field('connectivity', 'Connectivity / ports'), field('battery_life', 'Battery life'),
  ]),
  template('power_banks', 'Power banks', [
    number('battery_capacity', 'Battery capacity', 'mAh'), number('output_power', 'Maximum output power', 'W'),
    field('ports', 'Input / output ports'), field('charging_protocols', 'Charging protocols'),
    field('battery_type', 'Battery type'), number('input_power', 'Maximum input power', 'W'),
    number('port_count', 'Number of output ports'), field('charging_time', 'Charging time'),
    yesNo('wireless_charging', 'Wireless charging'), field('indicator', 'Charge indicator'),
    notes('safety_features', 'Safety features'),
  ]),
  template('cables_adapters', 'Cables & adapters', [
    field('connector_type', 'Connectors (input / output)'), number('cable_length', 'Cable length', 'm'),
    number('output_power', 'Supported charging power', 'W'), field('data_transfer_rate', 'Data transfer rate'),
    field('compatible_devices', 'Compatible devices'), field('material', 'Material'),
  ]),
];

// Matching terms identify a specification template, never a particular model.
const aliases = {
  smart_watches: ['smartwatch', 'smartwatches', 'smart watch', 'apple watch', 'galaxy watch', 'pixel watch'],
  watches: ['watch', 'watches', 'digital watch', 'digital watches', 'wristwatch', 'wrist watch', 'analog watch', 'analogue watch'],
  hair_dryers: ['hair dryer', 'hairdryer', 'blow dryer', 'hair dryers'],
  personal_care: ['trimmer', 'shaver', 'hair straightener', 'hair curler', 'personal care'],
  torches_lights: ['torch', 'torches', 'solar torch', 'flashlight', 'emergency light', 'rechargeable light'],
  power_banks: ['power bank', 'powerbank', 'battery bank', 'bettery bank'],
  televisions: ['tv', 'television'], speakers: ['speaker', 'soundbar'],
  headphones: ['headphone', 'headset'], earphones: ['earphone', 'earbud'],
  screen_protectors: ['screen guard', 'screenguard', 'screen protector', 'tempered glass'],
  irons: ['electric iron', 'steam iron', 'dry iron', 'garment steamer'],
  washing_machines: ['washing machine'], pressure_cookers: ['pressure cooker', 'cooker', 'kukar'],
  mixer_grinders: ['mixer grinder', 'mixer', 'blender', 'juicer', 'mixie'],
  refrigerators: ['refrigerator', 'fridge', 'freezer'], air_conditioners: ['air conditioner'],
  fans_coolers: ['ceiling fan', 'table fan', 'air cooler'], microwave_ovens: ['microwave', 'air fryer', 'oven'],
  cooktops: ['cooktop', 'induction stove', 'gas stove'], kettles_rice_cookers: ['kettle', 'rice cooker'],
  water_purifiers: ['water purifier'], laptops: ['laptop', 'computer'], cables_adapters: ['usb cable', 'adapter'],
};

function expandCatalog(structure) {
  if (!structure || !['mobile', 'electronics'].includes(structure.industry || structure.id)) return structure;
  const definitions = [...(structure.categoryDefinitions || [])];
  for (const addition of templates) {
    const index = definitions.findIndex(item => item.key === addition.key);
    if (index < 0) {
      const modelNumber = (structure.attributes || []).find(item => item.key === 'model_number');
      const expanded = { ...addition, aliases: aliases[addition.key] || [] };
      definitions.push(modelNumber ? { ...expanded, attributes: [...addition.attributes, { ...modelNumber, required: false }] } : expanded);
    }
    else {
      const saved = definitions[index];
      const keys = new Set([...(structure.attributes || []).map(item => item.key), ...(saved.attributes || []).map(item => typeof item === 'string' ? item : item.key)]);
      definitions[index] = { ...saved, aliases: [...new Set([...(saved.aliases || []), ...(aliases[addition.key] || [])])], attributes: [...(saved.attributes || []), ...addition.attributes.filter(item => !keys.has(item.key))] };
    }
  }
  return { ...structure, categoryDefinitions: definitions.map(item => aliases[item.key] ? { ...item, aliases: [...new Set([...(item.aliases || []), ...aliases[item.key]])] } : item) };
}

module.exports = { expandCatalog };
