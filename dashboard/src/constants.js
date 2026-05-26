export const CLUSTER_COLORS = [
  '#185A7C', '#E86C4B', '#47a36d', '#7c6daa', '#2a9d8f',
  '#d4851e', '#c0392b', '#5b8c5a', '#8ab5cc', '#b07d4f', '#6b7280'
];

export const SHORT_NAMES = {
  'Planning Method': 'Planning Method',
  'Training Data': 'Training Data',
  'End-effector Hardware': 'End-effector',
  'Object Configuration': 'Object Config',
  'Input Data': 'Input Data',
  'Output Pose': 'Output Pose',
  'Corresponding Dataset (see repository linked above)': 'Dataset',
  'Simulator (see repository linked above)': 'Simulator',
  'Backbone': 'Backbone',
  'Metric(s) Used ': 'Metrics',
  'Camera Position(s)': 'Camera',
  'Language': 'Language',
  'Description': 'Description',
  'License': 'License',
  'Link(s)': 'Links',
  'Year (Initial Release)': 'Year',
  // Derived
  'Grasp Dimensionality': 'Grasp Dim.',
  'Learning Paradigm': 'Learning',
  'Sensor Complexity': 'Sensor',
  'Scene Difficulty': 'Scene',
  'Gripper Type': 'Gripper Type',
  'ML Framework': 'Framework',
  'Method Era': 'Era',
};

export const COLOR_BY_OPTIONS = [
  { value: 'cluster', label: 'Cluster' },
  { value: 'Planning Method', label: 'Planning Method' },
  { value: 'End-effector Hardware', label: 'End-effector' },
  { value: 'Object Configuration', label: 'Object Config' },
  { value: 'Input Data', label: 'Input Data' },
  { value: 'Training Data', label: 'Training Data' },
  { value: 'Output Pose', label: 'Output Pose' },
  { value: 'Backbone', label: 'Backbone' },
  { value: 'Camera Position(s)', label: 'Camera' },
  { value: 'Corresponding Dataset (see repository linked above)', label: 'Dataset' },
  { value: 'Simulator (see repository linked above)', label: 'Simulator' },
  { value: 'Learning Paradigm', label: 'Learning' },
  { value: 'Sensor Complexity', label: 'Sensor' },
  { value: 'Scene Difficulty', label: 'Scene' },
  { value: 'Gripper Type', label: 'Gripper Type' },
  { value: 'Method Era', label: 'Era' },
];

export const DEFAULT_WEIGHTS = {
  'Planning Method': 10,
  'Training Data': 8,
  'End-effector Hardware': 6,
  'Object Configuration': 10,
  'Input Data': 6,
  'Output Pose': 10,
  'Corresponding Dataset (see repository linked above)': 5,
  'Simulator (see repository linked above)': 3,
  'Backbone': 5,
  'Metric(s) Used ': 5,
  'Camera Position(s)': 4,
  'Language': 4,
  'Description': 7,
};

export const WEIGHT_COLUMNS = Object.keys(DEFAULT_WEIGHTS);

export const TABLE_COLUMNS = [
  'Planning Method',
  'Training Data',
  'End-effector Hardware',
  'Object Configuration',
  'Input Data',
  'Output Pose',
  'Corresponding Dataset (see repository linked above)',
  'Simulator (see repository linked above)',
  'Backbone',
  'Metric(s) Used ',
  'Camera Position(s)',
  'Language',
  'License',
  'Link(s)',
  'Year (Initial Release)',
];
